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


For grouped issue-ready text, use the same input/reference binding with `--format issue`:

```sh
rig-review feedback /absolute/output --reference /absolute/original.mp4 --format issue
rig-review feedback /absolute/a --compare /absolute/b --reference /absolute/original.mp4 --animation dance --format issue
```

The header counts feedback records by defect/quality and by build; blocks group by category, then exact target kind/name. Overlapping intervals and A/B sides remain distinct items. Each block retains its id, inclusive interval, one-line summary and selected/full paired provenance. Historical tool identities and validation warnings remain visible; output never migrates approval, writes state or publishes an issue. Default output and `--format json` remain the existing session JSON. Only feedback accepts `--format`, with `json` or `issue` as its value.

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
saved views; fresh inspections start with sync on. Legacy modeling/motion
workspace selections are accepted without restoring a top-level workspace switch. A link
for a different source binding is refused.

Ordinary form inputs, selected panels, view state and unsent feedback/checkpoint
choices are kept in browser local storage for the same source. Changing the
model/source clears the previous draft in that page's storage scope. The global
appearance preference remains, while a source-bound appearance override does
not carry over. URL view state takes precedence over the locally saved view.

Local recovery compares the original submitted server-session fingerprint,
including its update time. It cannot replace a newer server review: conflicting
or corrupt saved data remains available to download, with an explicit warning;
recovering a conflicting draft requires choosing a pending review. Storage
errors never count as a successful save. Nothing is written to the server or
input package merely by restoring a page. Browser storage is convenient local
recovery, not a durable backup; export feedback separately when it must be kept.
Control capabilities are excluded from links and browser persistence.


## Inspect a part

The right Parts explorer selects an actual model slot on a specific single/A/B side. All rows follow the public held snapshot's exact draw-order z, including hidden/null slots. Search matches the exact source slot names: a row is shown when its name contains the typed text, case-sensitively, with no case folding or normalization. Arrow keys/Home/End move between result buttons, Enter/Space selects, and Escape returns to search. Whole rig restores full drawing. Selecting a drawn row fits its conservative world bounds within the existing camera zoom range; Sync cameras applies the same normalized camera action to every visible pane, while independent mode changes only that selected pane. Hidden/empty geometry reports `PART_FIT_UNAVAILABLE` and keeps the camera.

Solo preserves the full held pose's resolved clips and filters only drawing. In context, the whole rig remains visible with an amber dashed conservative selection box; this box is geometry/clip bounds, not exact source-alpha coverage. Selection changes no track, skin, set, motion, source asset or review decision. The selected slot's side/mode survives source-bound links and local drafts. The Rig inspector shows actual posed mesh counts or region corners, page/region, current skin/set context and declared attachment candidates. **Use slot for feedback** explicitly prefills the target; selecting a row alone submits nothing.

The pinned published `@rig-c/play`1.12.0 supplies `slotIdentity()` and frame generation. The explorer atomically retains the public identity snapshot with the same-generation held frame: exact attachment key, owning skin, active set/skin, full z order and explicit hidden/no-attachment/timeline-null/set-hide reasons. Hidden/null slots keep null keys with their reported reason; declarations and texture/UV names never replace that public result. An identity-known attachment need not have a visible primitive or positive fit bounds. The current UI follows its selected slot as animation changes, updating the displayed identity to the actual held frame.

Source-bound links/drafts and explicit feedback preserve that side/slot plus exact attachment/owning skin/set/active skin/null reason. A restored explicit target is checked after restoring its animation/time/set and drawing; `PART_IDENTITY_MISMATCH` rolls back rather than silently substituting another key. Older slot-only links remain readable and resolve from the current authoritative snapshot. Runtime generation is current observation/feedback evidence, never a persistent identity. Named vertex weights and original source alpha remain unavailable in this inspection; packed pages are not original part images.

This explorer is inspection. Producer-backed optimization, candidate Apply/undo/export and permanent resizable-panel settings remain separate work; the explorer does not generate mesh, rig or motion bytes.
