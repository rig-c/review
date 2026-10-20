# review

A reusable local workspace for a person to inspect an agent's rig output, compare source references, and export feedback ready to become an issue. The person receives a package or opens an existing output folder; the agent does not build a new viewer for each rig.

The app provides one inspection workspace for setup geometry and motion, compiled-model playback through `@rig-c/play`, local image, video and pose-sequence references, checkpoints, audio audition, and saved structured feedback. **Motion is view, annotate and export only.** Navigation changes inspection time; it never retimes, authors keys, or writes `motion.json`. Modeling touch-up remains a design goal; this starter does not edit meshes, weights or source art.

## Place in the toolchain

[Parts](https://github.com/rig-c/parts) → [Pose](https://github.com/rig-c/pose) →
[Core / rigc](https://github.com/rig-c/core) → **Review** →
[Play](https://github.com/rig-c/play) → **Adapter** (consumer integration).

Review is the human inspection and source-bound feedback gate in this delivery
flow. It inspects the upstream build without replacing Core's compiler gate or
authoring motion. Review itself uses the published Play runtime for previews;
the chain describes delivery and feedback responsibilities, not runtime import
order. Adapter denotes downstream consumer integration, without promising an
unreleased adapter API or changing existing compilation/playback dependencies.

## Start

Install it beside the agent that produced the output, then open that output folder:

```sh
npm i -D @rig-c/review
npx rig-review open /absolute/path/to/output
```

`rig-review` runs under **Bun 1.3.0 or later**, which must be on `PATH`; CI runs the installed package on 1.3.0 and on the latest Bun. `open` prints a loopback URL and exits; see [One-command owner handoff](#one-command-owner-handoff). `npx rig-review --help` lists every command.

The package is 0.1.x: the CLI is the supported surface, and no importable API is promised yet (`exports` exposes only `package.json`).

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

The server prints the exact link, for example `http://127.0.0.1:4317/?checkpoint=silhouette#cap=…`. The `#cap=` fragment is this server's write capability (see [Managed front and write capability](#managed-front-and-write-capability)). `--port 0` selects a free port. It binds only `127.0.0.1` and never opens a browser automatically. A folder containing `review.json` uses that explicit manifest.

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

Opening leaves status **pending**. The person explicitly saves **approved**, **changes-requested**, or **pending**, checkpoint outcomes/notes, and feedback containing an inclusive frame interval, a bone/slot/rig target, defect/quality category and one-line summary. Frame numbers are entered explicitly; the app does not invent a source FPS. **Write review**, at the top right, opens the review dialog: review status, reviewed source, selected checkpoint, structured feedback and the frame-strip export. Its **Submit review** saves that explicit status and feedback; closing the dialog keeps the unsubmitted draft. The page has no feedback export buttons: `rig-review feedback --format json` and `--format issue` (below) are the export path, and carry the original source binding and reproducible inspection context. Each submission records `reviewedSource`: package revision, actual viewer/runtime versions, and separate exact-byte SHA-256 plus path for the reviewed rig and motion; an absent artifact stays null. An active compiled model is the rig identity; raw skeleton JSON is evidence with playback unavailable.

New submissions validate bone/slot names against the exact loaded model; the target field offers those names. A rig target names the package id. Source-only packages cannot validate a bone/slot target and say so explicitly. When a matching animation has a declared producer clock, the inclusive interval cannot end beyond the last declared sample at or before the actual clip end. Unknown clocks keep manual frame intervals without inventing a limit. `context.interval` records the chosen interval; inspection `time`/`frame` remain separate. Older invalid feedback stays readable with per-row warnings and exports its original evidence, but cannot be resubmitted until corrected or removed.

Feedback lives under `~/.local/state/rig-c-review/`, separate from delivered files. Identity, revision and a streaming SHA-256 of the normalized manifest plus declared files/model pages bind each saved session. Changed content starts a new pending session, even without a revision bump. Restart the server after changing inputs. Saving or exporting feedback never modifies a model, authors correction keys, writes motion output or publishes an issue automatically.

After the person submits, the producing agent retrieves the stored review without needing the hashed state filename:

```sh
bun run feedback -- /absolute/path/to/output
# Or the same explicit review.json originally opened:
bun run feedback -- /absolute/path/to/package/review.json
```

This read-only command prints the session JSON, including reviewed artifact identity and feedback. The exact current-tool session wins when present. After a viewer/runtime upgrade, if that exact session is absent, the CLI can retrieve the latest saved submission over the same content with its original recorded versions and `retrieval: {kind:"prior-tools", toolsChangedSince:true, matchingSubmissions, currentTools}`. It does not migrate approval into the current UI or change saved bytes. Changed inputs still return a fresh pending session; a prior submission is never borrowed across content, revision or reviewed-artifact changes. The same lookup applies to `feedback compare`, preserving both recorded side bindings, reference identity and animation. See [historical retrieval](docs/REVIEW_PACKAGE.md#historical-feedback-retrieval) for selection and validation rules.


For grouped issue-ready text, use the same input/reference binding with `--format issue`:

```sh
rig-review feedback /absolute/output --reference /absolute/original.mp4 --format issue
rig-review feedback /absolute/a --compare /absolute/b --reference /absolute/original.mp4 --animation dance --format issue
```

The header counts feedback records by defect/quality and by build; blocks group by category, then exact target kind/name. Overlapping intervals and A/B sides remain distinct items. Each block retains its id, inclusive interval, one-line summary and selected/full paired provenance. Historical tool identities and validation warnings remain visible; output never migrates approval, writes state or publishes an issue. Default output and `--format json` remain the existing session JSON. Only feedback accepts `--format`, with `json` or `issue` as its value. These two formats are how submitted feedback leaves the tool; the browser page offers no JSON or Markdown download.

## Development

From a clone:

```sh
bun install
bun run demo
```

Open the printed loopback URL. The bundled original lantern study has source art, an explicitly synthetic canonical pose-sequence sample and an original synthetic chime. It has no compiled model: playback remains unavailable until a real model is supplied. Inside a clone, `bun run review -- <dir>`, `bun run check -- <dir>` and `bun src/cli.ts <command>` are the same CLI as `npx rig-review`.

```sh
bun run typecheck
bun test
bun run build
bun run smoke
```

`smoke` packs this tree, installs the tarball into an empty project, and runs the installed bin: `--help`, `open --help`, `check` on the bundled demo, and a served page whose browser bundle is built from the installed files. A file missing from `files` in `package.json` fails there, not after publishing.

The server bundles `web/main.ts` at startup using the pinned installed runtime, with no CDN. `build` verifies that browser bundle in memory. CI checks types, focused path/state/API tests, bundling and the demo package. Follow AGENTS.md for contributor verification policy. [DESIGN.md](docs/DESIGN.md) distinguishes the runnable foundation from future modeling touch-up and preserves the illustrative screen concept.

### Releasing

Releases are cut by `.github/workflows/release.yml`. On every push to main, release-please keeps a `release: vX.Y.Z` pull request whose version comes from the conventional-commit subjects since the last release. Merging it tags the version, creates the GitHub release, runs typecheck and the install smoke on the tagged tree, and publishes to npm through trusted publishing (OIDC) with provenance. No npm token is stored. Nothing is published until a release PR is merged.

## Frame strip export

The strip panel exports the explicitly entered inclusive feedback interval, or all current in-memory feedback intervals, as a PNG or JSON download. Batch selections include unsaved annotations; they do not submit or approve a review. Choose a declared reference video in single-package mode and an explicit clock basis A/B in compare mode. Every selected feedback interval must identify the selected animation. Separate intervals remain separate strip groups, including overlaps.

The same export is available without a browser:

```sh
bun src/cli.ts strip /absolute/package/review.json --reference source-video --animation dance --frames 176:184 --out /absolute/external/strip.png
bun src/cli.ts strip compare /absolute/a /absolute/b --reference /absolute/reference.mp4 --animation dance --basis b --frames 176:184 --out /absolute/external/compare.png
bun src/cli.ts strip /absolute/package/review.json --reference source-video --animation dance --all-feedback --json
```

Single `--reference` is a declared video **id**; compare uses the explicitly selected local video path. `--all-feedback` reads only the exact current saved session, and retains each item's side/interval. `--json` produces a selection/provenance plan without rendering; optionally add `--out`. PNG writes an additional `.png.json` provenance sidecar with the actual decoded samples and PNG hash. Destinations must be new files outside every input package, in existing directories without symlink parents. The server exposes download blobs, never a destination-path API.

Strip times require the selected report's exact `frameTimes` and matching animation. Missing or uniform-only clocks refuse PNG with `Report has no frameTimes — regenerate with pose 0.30.0 or later`; JSON retains requested frames with `time:null`. The other compare side may lack a clock: it can still be posed at the common seconds, while its frame label stays unknown. No frame rate is inferred from frame count, duration or video metadata.

PNG export uses the pinned published `@rig-c/play` canvas player and real Node Canvas2D, with `ffmpeg` (5.1 or later, for `-fps_mode`) and `ffprobe` available on PATH for reference decoding. Missing capabilities fail by name. Each requested sample chooses the nearest actual decoded reference PTS (ties earlier); both rigs seek that actual PTS using the viewer's fixed step. JSON distinguishes requested time, actual PTS, delta, decoded frame index, actual player times and independently known producer frames. Requests outside the common domain refuse instead of clamping. The PNG shows source rows, chronological frame columns, and full source hashes/revisions/tool and renderer versions. Batch groups stack vertically. Exports are bounded to64 intervals,256 total frames,64 megapixels and16384 pixels per dimension; larger selections must be split.

The footer fits its measured text while retaining full hashes. RGB/dark-tint features unsupported by the published Canvas2D path refuse with `STRIP_UNSUPPORTED_TINT`; they are not silently omitted.

## One-command owner handoff

`open` validates and hashes an existing folder, starts a background loopback
instance or reuses the exact matching one, prints its hash-bound URL, and exits.
By default the URL goes through the managed front at `127.0.0.1:4318`; `--direct`
prints the instance's own port instead (see [Managed front and write capability](#managed-front-and-write-capability)):

```sh
bun run open -- /absolute/output --reference /absolute/original.mp4
# Installed executable mapping:
rig-review open /absolute/output --reference /absolute/original.mp4 --animation dance
rig-review feedback /absolute/output --reference /absolute/original.mp4
rig-review open /absolute/a --compare /absolute/b --reference /absolute/original.mp4 --animation dance
rig-review feedback /absolute/a --compare /absolute/b --reference /absolute/original.mp4 --animation dance
# Producer handoff (single review only): the config, parts and inspected rig an Apply rebuilds from
rig-review open /absolute/output --config /absolute/output/rig/config.json [--parts /absolute/output/rig/out] [--source <png> --full <dir> [--head <dir>]]
rig-review feedback /absolute/output --config /absolute/output/rig/config.json
```

`--config`, `--parts`, `--source`, `--full` and `--head` declare the producer
handoff (see `docs/REVIEW_PACKAGE.md`, *Producer handoff*). They win over the
review.json `producer` block, which wins over discovery (`config.json`, then
`rig/config.json` inside the opened folder, then `../config.json` beside an opened
`out/`, named as discovered outside the folder). Every path must sit inside the
package root; a path outside it or a symlink that leaves it is refused by name.
The handoff files are hashed into the reviewed identity, so `feedback` and
`control` take the same flags to retrieve the same session, and changing the
config bytes starts a new pending review. `--parts` and `--source`/`--full`/`--head`
need `--config`; `--source` and `--full` go together; compare takes none of them.

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

### Launcher contract

A launcher may start `rig-review open` as a child process and rely on its stdout,
stderr and exit code alone:

1. On success stdout is exactly one line, the URL. `open` never writes anything
   else to stdout.
2. On success stderr carries the human lines in this fixed order: the animation
   diagnostic (when a clip is selected), the control notice (with `--control`),
   then the copyable retrieval line `Review started|reused; feedback: rig-review feedback …`.
3. A refusal exits with code 1, writes nothing to stdout, and its first stderr line
   starts with a name, followed by a colon and the explanation:
   - `OPEN_INPUT_MISSING <path>`: the input or `--compare` path does not exist, or is neither a directory nor a regular file.
   - `OPEN_INPUT_UNRECOGNIZED <path>`: the folder holds no recognized model, skeleton, motion, report, reference or pose sequence, or the file is not a JSON manifest.
   - `OPEN_REFERENCE_REQUIRED`: `--compare` was given without an explicit `--reference`.
   - `OPEN_ANIMATION_UNKNOWN <name>`: the explicit or report-named clip (JSON-quoted) is not in the compiled model.
   - `OPEN_ANIMATION_AMBIGUOUS`: no flag or report selects one clip, or the A/B reports conflict.
   - `OPEN_ANIMATION_UNVALIDATABLE`: a clip was requested but no compiled model can validate it.
   - `OPEN_OPTION_INVALID <flag>`: an unknown, duplicate, empty or value-less option, a handoff flag without `--config`, `--source` without `--full` (or the reverse), or a handoff flag with `--compare`.
   - `OPEN_HANDOFF_INVALID <flag or path>`: a declared or discovered producer handoff path is refused — `HANDOFF_PATH_OUTSIDE_ROOT`, `HANDOFF_SYMLINK_ESCAPE`, `HANDOFF_INPUT_MISSING`, `HANDOFF_INPUT_INVALID` or `HANDOFF_PATH_INVALID`, named after the colon.
4. Exit codes: 0 applied, 1 refused. (`control` keeps its own exit 2 for an
   unapplied command.)

Package validation and worker startup refusals keep their existing messages; the
named refusals above are decided before any state is written.

### Managed front and write capability

`open` is **managed by default**. It ensures one detached loopback front at
`127.0.0.1:4318` (`RIG_REVIEW_FRONT_PORT` overrides) for the state directory and
prints `http://127.0.0.1:4318/instances/<key>/?input=…&handoff=…#cap=…`. Every
inspection therefore shares one stable browser origin, so Settings, panel sizes and
source-bound drafts survive a reopen. The front only routes: it takes the worker
address from that key's private open record, allows a closed per-method route
list, bounds bodies (16 KiB control, 1 MiB session/strip) and upstream time,
limits concurrent upstream streams, re-verifies the worker's nonce on every
request, and refuses an unknown, expired or replaced instance by name
(`FRONT_INSTANCE_UNKNOWN`, `FRONT_INSTANCE_EXPIRED`, `FRONT_INSTANCE_REPLACED`).
Worker error text is not passed through; failures become named `FRONT_*` codes.
Package assets keep their `sandbox` CSP through the front. It never reads packages.
Idle fronts exit after 30 minutes once no live instance remains.

If another listener holds the front port, `open` fails with
`FRONT_PORT_BUSY: 127.0.0.1:4318 is held by another listener; use --direct` and
does not fall back silently. `open --direct` keeps the per-instance port and
prints that worker's own URL.

One origin cannot isolate scripts that run on it, so writes are bound to a
per-instance capability rather than to the page's origin or the key in its path.
Each worker mints a 256-bit capability kept only in its private 0600 open record.
`open` (managed or direct) and the foreground `review`/`review compare` commands
print it in the `#cap=` fragment, which browsers never send to a server. That
printed link goes only to the terminal of the command that started the instance.
Output meant for a log does not carry it: the install smoke (`bun run smoke`, whose output CI publishes) prints the same
URL as `#cap=<redacted>` and fails if any capability value reaches its stdout. The page
moves it into memory and that tab's `sessionStorage`, then removes the fragment
from the address bar. Every mutation sends it as `X-Review-Capability`; the front
checks it before forwarding and the worker compares it again in constant time
before its existing same-origin check. No endpoint returns it, so a page opened
for one instance cannot submit to another. A copied view link (without the
fragment) opens read-only and says *Read-only view: reopen with rig-review open to
edit*; run `open` again for a writable link.

## Control the current inspection page

Opt in once when opening a fixed package, then keep that page open:

```sh
rig-review open /absolute/output --reference /absolute/original.mp4 --control
rig-review control /absolute/output --reference /absolute/original.mp4
```

The second command reads the connected page's actual inspection state and its
`pageId`/`revision`; it does not open a browser or start another worker. To change
that page, use the observed values and a closed inspection command:

```sh
rig-review control /absolute/output --reference /absolute/original.mp4 --page '<pageId>' --expected-revision 0 --request-id theme-1 --command '{"type":"theme","value":"light"}'
```

Use the same reference/compare/animation inputs as the controlled `open`. Multiple
pages require an explicit `--page`. The URL and source binding stay unchanged;
existing ordinary servers do not become controllable. Starting the opt-in worker
is a one-time handoff, not a new link for each parameter change.

Commands cover appearance, automatic layout, synchronized or independent pane
cameras, playback, single animation, time and actual inspection layers. Camera
pan is measured in viewport CSS pixels (right/down positive). New inspections
start with camera sync on: zoom relative to fit and pan normalized by each pane's
viewport move all visible measurable reference/rig panes together. Turn sync off
with `{"type":"camera-sync","value":false}` to inspect each pane independently;
turning it off preserves current views. Turning it on aligns the visible panes
to the last active pane. Camera/fit targets are `rig|reference` in single review
and `a|b|reference` in compare. For legacy clients, compare `target:"rig"` explicitly
moves both A/B even when sync is off; its CSS readback aliases A. Comparison retains its
fixed animation and actual video-master seek path. A single-video time request
uses the actual decoded timestamp for both reference and rig; the applied
acknowledgement reports that time, which may differ from the requested seconds.
Unsupported features, stale
page/source/revision, unsubmitted feedback drafts and out-of-range values refuse
by name. No command changes a package/reference, authors motion, or submits or
approves feedback. Local controls and remote readback use the same inspection
state. A live view-link/history change supersedes pending remote work, and
commands refuse while that view is being restored.

Remote inspection readback also includes versioned numeric `view` coordinates
when the page can measure them: rig/world center and zoom, reference/image center
and zoom, each panel's current CSS viewport size and visible rectangle. World
coordinates use Y up; reference image coordinates use Y down. Compare reports
actual A and B rectangles separately; unavailable measurements are null. The
canonical view also reports `cameraSync` and `activeCamera`. These
are the same current cameras used by the local controls, rather than a second
simulated view. Camera commands still use the documented viewport CSS pan.

The CLI waits up to10 seconds for the page's actual acknowledgment. `queued` or
`dispatched` is not success; non-applied commands exit2 and may carry
`timedOut:true`. Reuse the same `--request-id` and original request to obtain its
receipt without applying it twice. `--wait-ms 0` returns the queued receipt;
`--wait-ms` is bounded to30000. A timeout does not mean an already delivered action
was rolled back. Tokens stay in private tool state, not URLs or command output.

## Keep and share an inspection

The view link stores the current numeric inspection in a bounded, versioned
`#review=` fragment. It includes the exact loaded source/model binding, selected
animation/time and reference selection, appearance/layers, camera sync and the
active pane, and each canonical camera center with visible bounds. Reloading a matching link restores a paused view;
it does not restart an idle loop or submit a review. Coordinates adapt to the
current viewport instead of replaying another window's CSS pan offsets.
Historical links without a sync mode restore with sync off to preserve their
saved views; fresh inspections start with sync on. The page keeps the current
fragment in the address bar as you inspect, so copying the address copies the
view; there is no separate copy button. Legacy modeling/motion
workspace selections are accepted without restoring a top-level workspace switch. A link
for a different source binding is refused.

Ordinary form inputs, selected panels, view state and unsent feedback/checkpoint
choices are kept in browser local storage for the same source. The draft scope
includes the source hash (`single:<id>:<sourceHash>`; compare uses both sides'
id and hash), so two revisions of one package keep separate drafts. Opening a page
deletes no draft; saving evicts the least-recently-written drafts beyond 32, but
never one written within the last 24 hours. Browser
Settings (below) remain, while a source-bound appearance override does not
carry over. URL view state takes precedence over the locally saved view. Each
Inspector section's own scroll position is part of this source-bound draft.

Local recovery compares the original submitted server-session fingerprint,
including its update time. It cannot replace a newer server review: conflicting
or corrupt saved data remains available to download, with an explicit warning;
recovering a conflicting draft requires choosing a pending review. Storage
errors never count as a successful save. Nothing is written to the server or
input package merely by restoring a page. Browser storage is convenient local
recovery, not a durable backup; submit the review (and retrieve it with
`rig-review feedback`) when it must be kept.
Control capabilities are excluded from links and browser persistence.

## Workspace settings and panels

The review page has a left column (Parts explorer, with checkpoints and the
reference select folded above it), the stage, the Inspector below it with
**Setup** and **Animate** sections, and a status footer. The compare page
keeps sources on the left and the Parts explorer on the right. The page
header carries the **Setup** / **Animate** mode switch next to the package
title; it is the only way to change the Inspector's section. Setup is the
mesh-review composition (selected part, part presets, modeling-review
proposals) and holds nothing that seeks or plays; the angle inspection, the
transport and frame navigation are in Animate. **Write review** at the top
right opens the review dialog, a modal holding the review status, reviewed
source, selected checkpoint, structured feedback and frame-strip export, with
its own **Submit review**. Escape or Close dismisses it and returns focus to
**Write review**; the draft keeps saving whether the dialog is open or not,
and the footer and the dialog both show its state.
The left column's header (Parts title and search) stays fixed at the top;
the checkpoint strip, the part list and Settings scroll beneath it as one
body. A drawer keeps its title and close button in place while its body
scrolls. The per-inspection **Repeat idle** toggle sits in the Animate
transport row.

Animate's **Environment** block drives the player's physics while you
inspect: a **Wind** base (−100…100), **Breeze**, a **Gust** pulse
(peak 0…200, duration 0.1…20 s, **Repeat** every max(6, duration + 0.6) s)
and **Gravity** (0…4), applied through `player.environment` in the same frame
step that draws. The gust clock is the stepped player time, so pausing freezes
it. **Jolt** sends a translate-and-return impulse through `player.moved`;
with **Drag to trail** on, dragging the rig pane moves the rig's physics
instead of the camera (Space still pans). **Reset physics** returns the
runtime start values and re-poses from the current time, clearing the physics
history. Until a control is touched the player stays at the runtime start values. The
state is kept in the local draft and recorded in feedback as
`context.environment`; nothing is written to the model or motion. The compare
page does not have this block.

Below it, the **Physics tuning** panel (`#physics-panel`) edits the physics
constraints through the producer. Each row is a constraint of the inspected
model, matched to the handoff config's `constraints[]` entry of the same name
and kind; a row is editable only when every field the panel edits reads the
same on both sides. Rows the model has and the config does not declare (the
rig stage's `turn` twins), the config's transform constraints and any row that
does not map 1:1 are listed under **Not editable** with the reason. Picking a
row opens its editor: a slider and number field for each of `strength`,
`damping`, `inertia`, `mass`, `wind`, `gravity` and `mix` the config declares,
and toggles for the `x`, `y` and `rotate` components (0 is off). A **Chain**
(from bone parentage: links on parent bones that move the same components;
pick one from the list or with **Pick on stage**) takes a **Ramp**: one value
per link, linear from root to tip. Every edit is a config patch op at
`/constraints/<i>/<field>` that also records the constraint's `name`; the
pending ops are listed with a per-op **Revert** and kept in the local draft.
**Apply** sends them as one patch (`rig`, then `check`, about 20–50 s on a real
package); the scratch build reloads under the same wind, gust, jolt and gravity
state Apply was pressed in, and the readout shows the `ANIMATIONS_DO_NOT_FOLD`
and `TEXTURE_STRETCH` lines before and after. BEFORE for the inspected build
is its own check: once the baseline reproduces, review runs `rig-parts check`
on that baseline output in the background (about 16 s on a real package) and
stores the summary beside the baseline record, so a reload reads it; until it
finishes the line says "check running…", a producer refusal is shown verbatim,
and "not in check summary" remains only when the baseline did not reproduce. A
refusal is the producer's line verbatim (`CONFIG_CONSTRAINT_*`,
`CONFIG_NAME_RESOLVES`, rigc's `A23` for a mass of 0) and the stage is
unchanged. **Reset** returns to the inspected build and clears the pending ops.
Submit refuses a review written on an applied build whose check failed
(`EDIT_SUBMIT_UNCHECKED`). Live preview before Apply waits on play#147.

Below it, the **Idle tracks** panel (`#idle-tracks`) edits the idle through
the producer. It lists the handoff config's `motion.tracks`: a single track
opens amp, period, phase and base (base can be added or taken out); a chain
track opens one amp per link and lag, and draws a handle at each link on the
stage (drag up or down; arrow keys step 0.05°). Period is a select of the
divisors of `motion.duration` (`duration / 1 … 12`) — the only periods the
producer accepts — beside a field for typing one, which review's pre-check
refuses with the producer's own line (`CONFIG_PERIOD_DIVIDES_DURATION`). A
track is added by bone + property or by chain (it starts still: amplitude 0,
the whole idle's period) and removed with **Remove**; a second track on a
property already keyed (a chain link's `rotate`, a blink member) is refused
before Apply by the producer's `CONFIG_BONE_PROPERTY_KEYED_ONCE`. The blink's
`t` is a marker above the transport scrub, dragged along the timeline (arrow
keys step one 12 fps frame), with `squash` and `brow_drop` sliders. The
pending ops (`/motion/tracks/<i>/…`, `/motion/blink/…`) are listed with a
per-op **Revert** and kept in the local draft. While edits are pending the
**preview** drives the edited bones through the player's `adjust` with the
producer's sine on the bone the idle keys (`<bone>_ctl` under ctl keys, read
off the handoff rig), labelled "preview — Apply decides"; it is never
recorded or submitted, and a property the inspected idle does not key yet is
not previewed (`IDLE_PREVIEW_TARGET_UNKNOWN`). **Apply** clears the preview and
sends one patch (`rig --idle-keys <the inspected rig's>`, then `check`, about
30 s on a real package); the built idle replaces the preview, and the
readout shows the `CHAIN_LAG`, `TIP_OVER_ROOT` and `BREATH_VISIBLE` lines and
check's `loop:` line before and after. **Reset** clears the preview and the
pending ops and returns to the inspected build.

Below that, the **Readings** block (`#readings`) runs the compiler's own
readings of the drawn animation: a **Folds** toggle, a **Pass-through**
cloth:leg pair and a **Seam** slot:slot pair (slot names suggested from the
model), an **Overlaps** toggle and an **Angle range** bone against a relative
bone. **Run readings** sends the chosen readings (names only) to
`POST /api/readings`; the server runs one `rigc render --animation <drawn>
--folds | --pass-through <cloth>:<leg> | --seam <a>:<b> | --overlaps |
--angle-range <bone>:<relative>` per reading on the inspected build and on the
latest scratch build of the session (if an Apply built one), into scratch
under the state directory (`readings/<package>/<build>/<key>/`; an identical
reading on the same build and compiler is reused; about 0.5–5 s each on a real
package). The frames each reading's JSON lists become ticks under the
transport scrub — inspected above, scratch below, in two colours — and
clicking a tick seeks to that frame's time (frame / fps). Each reading gets a
worst-frame line, `<build> · <reading> <pair>: worst at frame N — <figure> ·
<rigc's line>`, which also seeks; folds and overlaps list each folding mesh or
moving pair under it. `--angle-range` writes no file, so its ticks are the
lowest and highest frames its printed line names. An unknown slot or bone is
rigc's to refuse, and its line is shown verbatim. While the Environment
controls are applied, their current wind and gravity go along as a one-step
`--environment` schedule (only when the installed rigc's `render --help` lists
the flag). A reading is not a gate; nothing is written into the package. The
pairs of the last run are recorded in feedback as `context.readings`.

The view bar is one row and keeps the layer toggles in reach in every section: **Images**
(`I`), **Mesh edges** (`M`) and **Bone points** (`B`). The keys do nothing while
a text field, textarea, select or editable text has focus, with Ctrl/Alt/Cmd
held, or on key repeat; Space stays pan and Enter stays frame entry. A disabled
toggle shows why as a tooltip, and the footer shows the same layer status. The
footer also gathers the message, player, layout, renderer, idle, remote control
and draft state; **View region** opens the numeric view. Side by side,
Reference and Rig are in the **View** menu at the right end of the view bar,
labelled with the current choice.

The side and bottom panels are resizable. The separators are thin (4px)
lines whose colour is never the scrollbar's; the grab area is wider than the
line. Drag a separator, or focus it
and use the arrow keys (Shift for larger steps) and Home/End. Escape, a
cancelled pointer or window blur during a drag returns the previous size. The
stage keeps a usable minimum. When the window is too narrow, the side columns
(left first on the compare page), and when it is too short, the Inspector, become explicit
drawers opened from buttons above the stage instead of shrinking to nothing. Responsive clamping
never overwrites the desired size, so a wider window restores it.

Settings, at the end of the left column's scrolling body, holds browser defaults: Theme, Sync cameras by
default, Repeat idle by default, and Reset layout. Defaults seed a new
inspection only. Theme is the page's only appearance control: it shows the
current inspection's appearance, and changing it applies it and saves it as the
default. A view link or source draft keeps its own appearance, camera
sync and idle choice, and restoring it neither changes the saved defaults nor
starts playback. Reset layout restores panel sizes and nothing else.

These defaults and desired panel sizes are one versioned, closed record in
browser `localStorage` (`rig-review-preferences/1`). It holds no source path,
hash, feedback, review decision or capability. The first load migrates the
earlier same-origin appearance preference. If storage is denied, unavailable
or the record is corrupt, the page uses defaults and every control keeps
working for that page; a corrupt record is refused rather than overwritten
until you change a setting. Several open tabs merge their writes per field, so
changing the theme in one tab does not undo a panel size changed in another.
Separate browser profiles keep separate preferences.

Browser storage is per origin. Managed opens share the front's one origin, so
Settings, panel sizes and drafts carry across reopens. `--direct` and foreground
serving use per-port origins and keep them separate.


## Inspect a part

The Parts explorer (left column; right on the compare page) selects an actual model slot on a specific single/A/B side. All rows follow the public held snapshot's exact draw-order z, including hidden/null slots. Search matches the exact source slot names: a row is shown when its name contains the typed text, case-sensitively, with no case folding or normalization. Arrow keys/Home/End move between result buttons, Enter/Space selects, and Escape returns to search. Whole rig restores full drawing. Selecting a drawn row fits its conservative world bounds within the existing camera zoom range; Sync cameras applies the same normalized camera action to every visible pane, while independent mode changes only that selected pane. Hidden/empty geometry reports `PART_FIT_UNAVAILABLE` and keeps the camera.

Solo preserves the full held pose's resolved clips and filters only drawing. In context, the whole rig remains visible with an amber dashed conservative selection box; this box is geometry/clip bounds, not exact source-alpha coverage. Selection changes no track, skin, set, motion, source asset or review decision. The selected slot's side/mode survives source-bound links and local drafts. The Setup section shows actual posed mesh counts or region corners, page/region, current skin/set context and declared attachment candidates. **Use slot for feedback** explicitly prefills the target; selecting a row alone submits nothing.

The pinned published `@rig-c/play`1.12.0 supplies `slotIdentity()` and frame generation. The explorer atomically retains the public identity snapshot with the same-generation held frame: exact attachment key, owning skin, active set/skin, full z order and explicit hidden/no-attachment/timeline-null/set-hide reasons. Hidden/null slots keep null keys with their reported reason; declarations and texture/UV names never replace that public result. An identity-known attachment need not have a visible primitive or positive fit bounds. The current UI follows its selected slot as animation changes, updating the displayed identity to the actual held frame.

Source-bound links/drafts and explicit feedback preserve that side/slot plus exact attachment/owning skin/set/active skin/null reason. A restored explicit target is checked after restoring its animation/time/set and drawing; `PART_IDENTITY_MISMATCH` rolls back rather than silently substituting another key. Older slot-only links remain readable and resolve from the current authoritative snapshot. Runtime generation is current observation/feedback evidence, never a persistent identity. Named vertex weights and original source alpha remain unavailable in this inspection; packed pages are not original part images.

This explorer is inspection. Producer-backed optimization and candidate Apply/undo/export remain separate work; the explorer does not generate mesh, rig or motion bytes.

## Chest regions (designate, rebuild, watch)

In **Setup**, the view bar's **Chest regions** button (pressed state; hidden in Animate) opens the chest-region editor bar directly under the view bar and enables editing on the rig pane. The bar has an **R** and an **L** group, each with **X**, **Y**, **R** (core radius, 6–120) and **Band** (4–120) in crop pixels, x screen-right and y down; **Mirror R → L** copies R's y, core radius and band to L; **Download JSON**; and **Apply · Rebuild**.

On the rig pane each region is drawn as two circles: the core (full weight) and a dashed outer circle at core + band, R in one colour and L in another (two theme tokens per side), with a centre handle, a core handle on the right edge, a band handle on the top edge and a label `R (x,y) r:… b:…` under the outer circle. Dragging the centre moves the region, dragging the core edge sets r and dragging the band handle sets the band, all in crop pixels through the current camera scale. Each drag and each committed bar value is clamped live with the public example rebuild script's non-overlap rule: integer values, both cores plus 8 px must fit the centre distance minus a 2 px margin (both shrink by one factor) and the bands share what remains. A side the rule changed flashes its label and the footer says `CHEST_REGIONS_CLAMPED`. A handle drag never moves the camera; a drag anywhere else, or with Space held, still pans, and the wheel still zooms.

The bar opens on **Circles** (the R / L groups above); **Landmarks** beside it (#105) states the chest the way the producer's `meshes.<part>.contour.bust` does. Three clicks on the part place the **right apex**, the **left apex** and the **cleavage** (each pick button arms the point its click places, then the next unplaced one; a placed marker drags), with **X** / **Y** fields for each in rig pixels, an **α** slider (core ratio, the producer's default 0.22), a **Clearance** slider (rig px, default 3.8) and optional **Bone R** / **Bone L** (empty is the producer's default, `boob_r` / `boob_l`). The two circles are drawn live with the producer's own derivation (`@rig-c/parts` `deriveBustRegions`): with `d` the distance from an apex to the cleavage, `R = round(d − clearance)`, `r = round(alpha × R)` and `band = R − r`, centred on the apex, named `bust_r` / `bust_l`, spacing 14. Review pre-checks the producer's one geometric refusal on the same numbers — `CONFIG_BUST_CLEARANCE` when `clearance <= 0`, `R_r + R_l >= |apex_r − apex_l|` or a radius is not positive — draws both circles in the overlap colour, shows the producer's detail, and Apply sends nothing. Otherwise Apply · Rebuild sends `{part, bust, configHash}`: the part's entry with `contour.bust` in place of `contour.regions` (the hand-written regions are dropped; every other field as written) goes to the same `rig-parts remesh --mesh` run as Circles, and the producer derives the circles again and judges the bones (`CONFIG_NAME_RESOLVES`) and a region declared twice (`CONFIG_REGION_NAME_UNIQUE`), verbatim. The part is the contour part whose entry already states `contour.bust`, else the one the bones name, else the only contour part. A config entry that states `contour.bust` seeds an untouched Landmarks mode.

Rig pixels are the whole figure's frame, which is the crop frame the model's stage fixes (below), so a click maps through the same crop → world mapping. A part's own image is that frame less the part's `parts.json` box less the producer's 4 px pad: rig = part image + (box.x − 4, box.y − 4) (`src/chest-landmarks.ts` `partToRig` / `rigToPart`).

**Apply · Rebuild** runs the installed producer on the designated regions and reloads the result on the stage, so the loop is point → rebuild → watch → repeat → submit. Review builds no mesh itself and never runs a manifest command:

- **Producer.** `@rig-c/parts`' `rig-parts`, resolved the way `rigc review` resolves `rig-review`: `node_modules/@rig-c/parts/package.json` in the nearest directory walking up from the package, then from the directory `rig-review open` was run in; its `bin` entry is read from that manifest, never from `PATH`. The compiler is the `rig-c` that `rig-parts` itself finds walking up from its own package. Absent: `MODELING_PRODUCER_NOT_INSTALLED: … — bun add -d @rig-c/parts`; older than the first release with `remesh` (1.40.0): `MODELING_PRODUCER_TOO_OLD <found> 1.40.0`. Review never installs anything.
- **Inputs.** The producer handoff (`docs/REVIEW_PACKAGE.md`, *Producer handoff*): `open --config` (and `--parts`), else the review.json `producer` block, else `config.json`, then `rig/config.json` inside the opened folder, then `../config.json` beside an opened `out/`. The parts directory defaults to `out/` beside the config and holds `parts.json`, `parts/` and the inspected `rig/`. The editor bar shows, before any Apply, how the config was found (declared, discovered, or discovered outside the opened folder), its path and SHA-256, and the baseline. Without a handoff the bar shows `MODELING_INPUT_UNAVAILABLE: config.json — looked at …` and Apply refuses `MODELING_HANDOFF_MISSING`, naming `--config`. The request carries only `{part, regions, configHash}`; the server reads the config, replaces `meshes.<part>.contour.regions` with the designated regions (every other field as written) and runs `rig-parts remesh --rig <out>/rig --config <config> --parts <out> --part <part> --mesh mesh.json --out revision`, then `rigc build --profile rig-play --pack` with the revision's own `--page-edges` / `--pack-shape`, both with the scratch directory as working directory. A region row with equal semi-axes and no clip is sent as the config's circle, any other as the 32-sample polygon. An untouched editor starts from the config's own circle regions and contour numbers.
- **Baseline.** Once per session, when the handoff and the producer both resolve, review runs `rig-parts rig --config <config> --parts <parts> --out <state>/baseline/<key>/baseline` and compares every file it writes (rig.json, motion.json, mesh_report.json, sets.json, images/*) with the inspected rig directory: `baseline: reproduced — rig.json <hash> = inspected <hash>`, or `baseline: not reproduced — <first differing path>`. The key is the package hash, the handoff record and the producer versions (no clock), so a reopen reuses the result. Ops that rebuild the whole rig refuse `EDIT_BASELINE_MISMATCH <path>` unless the baseline reproduced; `remesh` keeps its own `REMESH_BASELINE_MISMATCH`. Once it reproduces, `rig-parts check` runs on the baseline output in the background (into `<state>/baseline/<key>/inspected-check/`, with Apply's default `--page-edges free --pack-shape polygon`) and its summary is stored beside the baseline record as `inspected-check.json`; that is the physics readout's BEFORE for the inspected build, and a reopen reads it instead of re-running.
- **Scratch.** `<state>/rebuild/<package source hash>/<designation hash>/` under `RIG_REVIEW_STATE_DIR` (refused inside the package), named from the package, the config bytes, the part, the entry and both tool versions — no clock. The same designation again reuses its build and says so; a new one replaces the previous scratch build. The inspected package's files are only read.
- **Watching.** The producer's lines stream into the editor bar (the latest line and a short log); a refusal shows the producer's first named line verbatim (for example `FAIL  REMESH_REQUEST_HELD: …`) and the stage is unchanged. On success the compiled scratch build (served read-only under `/rebuild/<id>/`, its model and pages hashed) replaces the drawn rig in place with the same camera, animation, time and part set; playback resumes with physics when it was running. **Reset** returns the stage to the inspected build.
- **Record.** The last applied state (`rig-review-applied/1`: part, regions, for a Landmarks Apply also `bust` — the entry as sent, with `regions` its two derived circles — config hash, entry SHA-256, producer and compiler versions, the producer's line and the scratch model's SHA-256) stays in the inspection draft, and feedback added while that build is on the stage carries it as `context.applied`. The review's `reviewedSource` still names the inspected build.
- **Config patch.** The same loop takes any config edit as data: `POST /api/rebuild {patch}` with a `rig-review-config-patch/1` document (JSON Pointer ops over the handoff config, refused `EDIT_PATCH_STALE` when made against other config bytes) rebuilds the whole rig (`rig`) or one part (`remesh`) into scratch, compiles it and runs `rig-parts check` on it; the page's `window.rigReviewEditor.applyPatch(patch)` streams, reloads and resets like Apply, and the draft and `context.applied` carry `rig-review-applied/2` (the patch, its hash, the producer's line, check's summary and the diff of every document the producer writes, per file, with the images by hash). Schema and refusals: `docs/REVIEW_PACKAGE.md`, *Config patch and Apply*.

The editor's values are the fields of Setup's **Chest regions · detail** block (R is region 1, L is region 2), which also holds what the bar does not: per region a name, a bone chosen from the loaded model's actual bones, the two semi-axes, a spacing and an optional medial clip x, plus the contour settings (tolerance, margin, spacing, max edge, stray, bridges). Setting R in the bar writes both semi-axes. A region with equal semi-axes and no clip exports as the examples' circle, `{"name", "shape": "circle", "cx", "cy", "r", "bone", "spacing", "band"}`; unequal semi-axes or a clip export as the generator's 32-sample polygon on its 1/256-pixel grid and are drawn filled, without handles.

The overlay needs the loaded model to fix the crop: its declared stage must be the crop frame with the root at its bottom centre (`x = -width/2`, `y = 0`) and the drawn root bone must sit at the world origin, so crop `(x, y)` is world `(x - width/2, height - y)`. Otherwise the editor bar and the detail block show `CHEST_REGION_MAPPING_UNAVAILABLE: <what is missing>`, nothing is drawn, and the values still edit numerically and export from a crop size you enter.

**Download JSON** (and the detail block's **Download chest-regions.json**) saves two files in the browser: `chest-regions.json`, formatted exactly as the public example files, and `chest-regions.binding.json`, which names the package source hash, the rig and motion SHA-256 values, the export time, the viewer and runtime versions and the mapping used. An export holds 1–8 regions, the set Apply accepts (#118): a detail row without a centre x is not designated, so one row exports alone; two regions keep the public examples' text byte for byte. Export refuses `CHEST_REGIONS_COUNT`, `CHEST_REGION_NAME_DUPLICATE`, `CHEST_REGION_BONE_UNKNOWN <bone>`, `CHEST_REGION_OUT_OF_CROP <name>`, `CHEST_REGION_OFF_GRID` and `CHEST_REGIONS_OVERLAP <a> <b>` (every pair is tested). Two circles overlap when their centre distance minus both cores is less than the sum of their bands; any other pair is tested through polygons. The generator refuses per mesh vertex, so this check can refuse a pair it would accept, never the reverse.

Field values stay in the inspection's local draft. They never enter the review session's feedback, nothing is written into the package, and an export is review evidence, not an approval (see `docs/DESIGN.md`).

## Mesh panel (density, regions, segments → remesh)

In **Setup**, under Chest regions · detail, the **Mesh** panel (`#mesh-panel`, #106) edits the selected part's `meshes.<part>` entry from the producer handoff's config — the entry `rig-parts remesh --mesh` takes — and rebuilds that one part. Select a mesh part in the parts list; the panel starts from the config's own entry (or the draft's pending entry for that part).

- **Modes.** The two modes whose fields the panel draws: **contour** (sliders for `tolerance`, `margin`, `spacing`, and optional `maxEdge`, `budget`, `stray`, each with a checkbox that declares or removes it; `bridges` as a checkbox) and **grid** (`grid`, optional top-level `stray`). In both: `r`, optional `exponent`, `rule` (absent / `distance` / `heat`), and the weight cut `influences.maxInfluences` and `influences.floor`. Each slider's range is review's drawing range only; the number field beside it takes any value and the producer judges it. An `auto` entry is shown with `MESH_PANEL_MODE` and no controls; an `influence` entry is not offered either, because `remesh --help` names grid, contour and auto entries and not influence (that is the producer's to document). The mode itself is not switched here.
- **Regions** (contour). **Add circle** adds a circle region (drawn like the chest editor's circles, in the mesh-region colour); **Draw polygon** arms the stage: each click places a point in rig px (whole pixels, so on the producer's 1/256 grid), **Enter** (or the button again) closes it with three or more points and **Escape** drops it. **Drag on stage** lets a polygon vertex or a circle centre be dragged; a drag never pans the camera. Each region row has its name, a bone chosen from the loaded model's bones, `spacing` and `band` (and `cx`, `cy`, `r` for a circle) and **Remove**. A `contour.bust` in the entry stays as written (the chest editor's Landmarks mode edits it).
- **Segments.** The entry's `segments` as written, each removable; **Add** appends a bone picked from the loaded model's bones. In contour mode each string segment (a chain) has a **ribs stations** field (empty: no ribs); removing a segment drops its ribs.
- **Pending entry.** The diff against the config's entry, one line per JSON Pointer (`/meshes/<part>/contour/spacing 28 → 20`). Review pre-checks the pending entry with the config loader's rules and names (`CONFIG_MESH_MODE`, `CONFIG_FIELD_PRESENT`, `CONFIG_FIELD_TYPE`, `CONFIG_REGION_NAME_UNIQUE`, `CONFIG_NAME_RESOLVES`, `CONFIG_RIBS_MODE`, `CONFIG_STRAY_MODE`) and Apply is disabled while one stands. What the outline refuses at the rig stage — a spacing whose keep radius snaps to 0 (`CONTOUR_PARAMETER`), a bridge no quad makes (`CONTOUR_BRIDGE`), a heat source (`RIG_HEAT_*`), a remesh rule (`REMESH_*`) — is sent and comes back as the producer's line.
- **Apply.** The pending entry becomes one config patch, `replace /meshes/<part>` with the whole entry and nothing else, run by `remesh --part <part>` through the patch runner (*Config patch* below): remesh into scratch, compile, check. On a build the revision replaces the drawn rig in place (same camera, animation, time and world), the **Mesh edges** layer turns on so the new triangulation is drawn, and the panel shows the part's vertex / triangle / hull counts before and after from the revision's `remesh.json`, one line comparing `remesh.json`'s after-count with the revision model's triangles for the slot and the triangles the overlay draws (`MESH_COUNTS_AGREE` / `MESH_COUNTS_DIFFER`, every figure named), and `TEXTURE_STRETCH` before (the build that was on the stage; for the inspected build its background check) and after. **Folds reading** runs the #108 folds reading of the drawn animation on the inspected build and on this revision and puts one worst-frame line per build in the status. A refusal leaves the stage and the pending entry as they were and the status line is the producer's line verbatim (for example `FAIL  REMESH_CANDIDATE_REFUSED: … CONTOUR_PARAMETER: contour mesh "<part>", spacing — is 0.003; its keep radius … snaps to 0 grid units of 1/256 px …`).
- **Reset** returns the pending entry to the config's and the stage to the inspected build.
- **Record.** The draft keeps `#mesh-pending` (`{schema:"rig-review-mesh-entry/1", part, entry}`, only while it differs from the config). A built Apply's `context.applied` is `rig-review-applied/2` with `mesh` added: the part and its counts before and after.

## Weights (setup pose, watch only)

In **Setup**, after the Mesh panel, the **Weights** block (`#weights`, #107; **Weights** in the block row) shows the selected slot's mesh weights as the compiled model document stores them. **Show weights** draws the slot's mesh at the setup pose over a veil that dims the rest of the rig: each vertex is a dot and each triangle is filled with the mean of its vertices' colours.

- **Bone weight.** Pick a bone (the slot's influencing bones first, then every other bone of the model): each vertex is coloured by that bone's stored weight on the weight ramp, 0 → 1 (`--rv-weight-0`, `--rv-weight-half`, `--rv-weight-1`); a bone that does not influence a vertex is 0 there. The legend shows the ramp and the bone.
- **Max influence.** Each vertex takes its dominant bone's colour (the largest stored weight; the first stored on a tie), from `--rv-weight-bone-1` … `-6` in the influencing bones' order; the legend names each bone with its colour.
- **Hover.** The vertex under the pointer (within 10 px) is ringed and labelled with its index, the bone and the weight drawn; the block's readout lists all of its stored influences. Values are printed as stored, never rounded or normalised.
- **Source.** The vertices and weights are the slot's attachment at the setup pose (`skins[].attachments.<slot>.<name>.vertices` of `rigc-compiled/3`: `{weighted:true, bindings}` — per vertex `{bone, x, y, weight}` — or `{weighted:false, xy}`). An unweighted mesh is its slot's bone at 1.0, named. A linked mesh reads its source mesh. The attachment is the one a never-played player resolves for the slot, and the positions are the stored bone-space coordinates through that player's setup-pose bones with the published player's skinning formula — the stage player is not touched, so the drawing can sit apart from an animated pose on the stage.
- **Refusals.** A package without a compiled model document refuses `WEIGHTS_MODEL_UNAVAILABLE`; no slot `WEIGHTS_SELECT_SLOT`; a slot without a mesh `WEIGHTS_NO_MESH <slot>`; a malformed attachment `WEIGHTS_MODEL_INVALID`.

Nothing here edits, applies or records a weight: the block adds nothing to the draft or to feedback, and weight editing is out of scope. With **Edit mesh** on, the weights layer is not drawn.

## Bones (config anchors, check, rebuild)

In **Setup**, after Weights, the **Bones** block (`#bones-panel`, #109; **Bones** in the block row) edits where the producer config puts its bones. It reads the handoff config's `bones` as written (`GET /api/rebuild` returns them as `bones`): a single bone `{name, parent, at, tip?}` or a chain `{chain, parent, points, tip}` whose links are `<chain>0 … <chain>n` (rig-parts AUTHORING, `bones`).

- **Stage mode.** **Edit bones on stage** (`#bones-edit`, `aria-pressed`; it pauses playback and ends when Setup is left) draws every anchor on `#rig-overlay` at its config position: an origin (`at`) as a square, a chain point as a circle, a tip as a diamond, joined along the chain or from the bone to its tip. Positions are rig px, y down, mapped to the rig world through the same crop → world mapping the chest and weights views use (the model's stage). They are the config's setup positions; an animated stage pose can sit apart from them. Without that mapping no handle is drawn and the block says why.
- **Drag.** Drag a handle (within 9 px) to move it; the pointer's delta is snapped to whole rig px and added to the config's value, written with the decimals that value already has (an integer stays an integer). **Bone** (`#bones-select`) picks a bone, whose anchors can also be typed. Each move is one config patch op, `replace` at `/bones/<i>/at`, `/bones/<i>/points/<k>` or `/bones/<i>/tip`, recording the bone's name (a chain's `chain`) beside the index; the server refuses an index that no longer holds that name (`EDIT_PATCH_NAME_MISMATCH`). The pending ops are listed with their delta and a Revert each; the draft keeps them (`#bones-pending`, `{schema:"rig-review-bones-draft/1", edits}`, restored only while each anchor still holds the value it was made from).
- **Check.** `POST /api/bones-check` applies the ops to a scratch copy of the handoff config and runs the installed producer on it: `propose --from-config` prints its LINT lines, the LINT count line and one coverage line per bone (shown as printed; a LINT line blocks nothing — propose exits 1 on any, and Apply stays enabled), and `compare --left <handoff config> --right <patched>` gives each moved bone's origin (and tip) distance and the summary lines. `propose --from-config` reads the source painting: a handoff without one (declare it with `--source <png> --full <dir>`) shows `MODELING_INPUT_UNAVAILABLE: source painting — …` in place of the LINT lines, and compare still runs. Any change to the pending ops clears the last Check's lines.
- **Apply · Reset.** Apply sends the ops as one `rig` patch through the generic runner (`rig --config`, compile, `check`): a whole-rig op, so it runs only when the baseline reproduced the inspected rig (`EDIT_BASELINE_MISMATCH` otherwise). A producer or rigc refusal (`RIG_TIP_DISTINCT` for a tip dragged onto its origin, `CONFIG_NAME_RESOLVES`, rigc's `A51`, `RIG_HEAT_BONE_SOURCE`, …) is shown verbatim and leaves the stage as it was. On a build the re-weighted rig reloads in place, and the Weights block reads the revision. Reset returns to the inspected build and clears the pending ops.

Adding, removing or re-parenting bones is out of scope.

## Rig fields (regions, still row, stops, inherit, turn)

In **Setup**, after Bones, the **Rig fields** block (`#rig-fields`, #110; **Fields** in the block row) edits the producer config's small fields. `GET /api/rebuild` returns them as written in `fields` (`regions`, `motion.blink`, `stops`, `bones`, `turn`); the block's state line counts what the config states. Every edit is one config patch op at the field's own pointer, listed with a Revert; the draft keeps the pending ops (`#rig-fields-pending`, `{schema:"rig-review-rig-fields-draft/1", edits}`, restored only while each field still holds the value the edit was made from).

- **`regions.<part>`** — the bone a rigid part rides. Pick the part (selecting a region part on the stage picks it) and its bone among the bones the config declares (chain links expanded, and `root`): `replace /regions/<part>`. A meshed part is not offered.
- **`motion.blink.still.<part>`** — a lash's still row, `{row, bone}`: rows above `row` (rig px, y down) are drawn by `<part>_still` on `bone` and do not blink. The block offers the region parts on a bone the blink's `eyes` names; **Add still row** starts at the eye bone's origin row on its parent. The row is drawn across the part on the stage and dragged in whole rig px (its number and bone can also be typed): `add /motion/blink/still/<part>` (with `add /motion/blink/still {}` first when the config states no `still`), **Remove** sends `remove`. It sits in Setup, beside the part it cuts, rather than in Animate's blink controls.
- **`stops[i]`** — a stop's inward and outward bounds (degrees). Picking a stop draws its two arcs on the stage at the first stopped link's origin, around the rest aim at the touch point (`at` in `against`'s frame, as rig-c's `expandStops` aims it); dragging an arc end sets that bound in whole degrees (never below 0). The op replaces the whole entry, every other key as written, and names its `chain`: `replace /stops/<i>`. Adding a stop is out of scope.
- **Inherit** — a single bone's `inherit`, or a chain link's entry in `link_inherit`, picked among rig-c's five modes (`normal`, `onlyTranslation`, `noRotationOrReflection`, `noScale`, `noScaleOrReflection`; absent is `normal`): `add` (or `remove`) at `/bones/<i>/inherit` or `/bones/<i>/link_inherit`, naming the bone.
- **`turn`** — the pivot and a part's depth, each a slider with a number: `replace /turn/pivot`, `replace /turn/depths/<part>`. The **dial** holds the drawn build's `turn` bone at x rig px through play's `adjust` (shared with the idle preview), labelled *preview — Apply decides*: it shows the build on the stage, not the pending depths, and it is never recorded. Apply and Reset set it back to 0. `turn.deform` is out of scope.

**Apply** sends the pending ops (checked against the block's scope, `RIG_FIELDS_OP_OUT_OF_SCOPE` otherwise) as one `rig` patch through the generic runner (`rig --config`, compile, `check`) — a whole-rig op, so it runs only when the baseline reproduced the inspected rig. rig-parts has no `retune` op yet; when it has, stops and inherit can move to it. The producer's refusal (`CONFIG_STILL_OFF_THE_BLINK`, `RIG_STILL_ROW_CLEAR`, `CONFIG_BONE_INHERIT`, `CONFIG_TURN_PIVOT_BEHIND_NEAREST` and the other `CONFIG_TURN_*`, `CONFIG_NAME_RESOLVES`, rigc's `RIG_STOP_BOUNDS`, …) is shown as printed and leaves the stage as it was. On a build the revision reloads in place, the status line names the per-file diff, and the readout shows check's `BLINK_NO_HOLE` and `FEET_STAY_LEVEL` lines before (the build that was on the stage, or the inspected build's stored check) and after. **Angle range** runs the angle-range reading (#108) on the inspected and the latest scratch build with one click: the inherit bone against its parent, else a re-boned part's new bone against the bone it rode, else the part's bone against its parent. **Reset** returns to the inspected build, clears the pending ops and sets the dial to 0.

## Mesh edit (typed delta, preview only)

In **Setup**, the view bar's **Edit mesh** button (pressed state; hidden in Animate) edits the selected slot's actual mesh attachment. With **Whole rig** selected it refuses `MESH_EDIT_SELECT_SLOT`; a slot whose active attachment is not a mesh refuses `MESH_EDIT_NO_MESH <slot>`. Entering pauses playback, turns the chest-region editor off and opens the mesh editor bar under the view bar. The rig pane dims except the slot's own triangles; the mesh is drawn at full opacity with every vertex as a handle, hull edges, interior triangulation edges and added constraint edges each in their own theme token.

The bar has four sub-modes, one pressed at a time, with single keys that avoid the layer keys `I` / `M` / `B`:

| Key | Sub-mode | Pointer |
| --- | --- | --- |
| `V` | Modify | drag a vertex, or an edge to move both ends; Shift-click adds to the selection; drag empty space to box-select; arrow keys nudge the selection 1 crop px (Shift 10) |
| `C` | Create | click empty space to add a vertex; click an edge to split it at the click point |
| `X` | Delete | click a vertex to remove it and its edges; click an edge to remove it (hull edges are refused, `MESH_EDIT_HULL_EDGE`) |
| `E` | Edges | click vertex A then vertex B to add a constraint edge; click a constraint edge to remove it; a hull edge is refused and an existing edge records nothing |

Hit-testing is in screen pixels through the current camera: a vertex within 6 px (8 on touch) wins over an edge within 4 px. In a sub-mode a press never pans; Space-drag still pans and the wheel still zooms. Escape leaves the sub-mode, a second Escape leaves mesh edit. **Undo** / **Redo** (Cmd/Ctrl-Z, Shift-Cmd/Ctrl-Z) step one action at a time — an edge or multi-selection drag is one action of several `move` ops. **Reset** drops the attachment's whole delta after a confirmation.

Everything is a typed delta over the loaded mesh, in crop pixels (x right, y down, the chest regions' crop mapping): `{slot, skin, attachment, source:{vertexCount, triangleCount, hullLength, hash}, ops}` with ordered ops `move {v, from, to}`, `add {at, onEdge?}`, `remove {v}`, `edge {a, b}` and `unedge {a, b}`. Source vertex ids are the attachment's indices; an added vertex takes the next id; a removed id is never reused. `hullLength` is the model's `hull` (the first `hull` vertices, in order, are the hull) and `hash` is the SHA-256 of the attachment's entry in the hash-verified model. The vertices are the slot's last drawn posed vertices, so `basis` names the animation and time they were held at. The overlay previews moved, added and removed vertices and the constraint edges over the original triangulation; nothing is retriangulated in the browser (the status line says *preview only — the producer retriangulates*).

**Download JSON** saves `mesh-edit.json` and `mesh-edit.binding.json` (package source hash, rig and motion SHA-256, the attachment and its hash, export time, viewer and runtime versions and the mapping). **Apply · Rebuild** refuses `MODELING_TARGET_UNSUPPORTED: the producer has no delta operation (parts); export the delta` and runs nothing: no producer command consumes a vertex delta. The delta rides in the inspection's local draft bound to the attachment hash (at most 300 ops per attachment); it never enters the review session and nothing is written into the package.

## License

MIT. See [LICENSE](LICENSE).
