# Inspection workflows

See [workspace panels](PANELS.md) for the controls, or [Start](../README.md#start) for installation.

## Existing output handoff

Open the current output folder directly, without changing the producing agent or inserting a manifest:

```sh
bun run check -- /absolute/path/to/output
bun run review -- /absolute/path/to/output
```

The adapter recognizes root `skeleton.model.json` or the fixed rigc build layout `build/skeleton.model.json` (root model takes precedence), root `motion.json`, `report.json`, `skeleton.json`/`.skel`/`.atlas`, source videos (`.mp4`, `.webm`, `.mov`), image filenames containing `strip`, `contact`, `sheet`, `filmstrip` or `띠`, and canonical `*pose*.json` sequences. Model discovery checks only those two named paths; it never recursively searches directories. A `rig-parts build` output root (`out/`: regular `parts.json` and `rig/rig.json`, a real `check/` directory and `check/build/skeleton.model.json`) that has neither model path itself opens as its `check/` package — the same package, identity and session as opening `out/check` — so `rig-review open <out>` works on a fresh build without copying `check/build` anywhere. Model page images resolve relative to the selected model, while motion and references remain relative to the opened folder. It builds the normalized review manifest in memory and reads source files without changing them. Motion/report/skeleton evidence links are read only. A recognized `rig-pose-report/1` also supplies read-only event markers: frame-only events retain their producer interval and explicitly lack seek until a declared clock is present; explicit event seconds can seek. Empty reported categories show none, while missing fields remain missing. Report markers prefill known feedback coordinates and actual bone/slot names without creating a review decision or motion keys. It exposes each matching video/strip separately, without guessing synchronization or source-to-rig bindings.

When the report declares `fps` plus `frame0` (seconds offset) and a frame count, or exact `frameTimes[]`, the matching animation also shows a producer-frame readout and frame seek controls. Without a bounded declared clock it shows `rate unknown`; current unchanged v19 has no clock. Sample times come only from the report, and feedback context records the recalculated frame or null.

A raw `skeleton.json`/`.skel` can still be inspected as evidence, but cannot play through the compiled-model runtime. Playback requires an upstream gated rigc build's `skeleton.model.json` with portable local page images inside the opened folder. `check` validates the delivery contract and model envelope, not the upstream compiler gate or visual quality.

For a curated handoff, [REVIEW_PACKAGE.md](REVIEW_PACKAGE.md) documents optional `review.json` with named checkpoints, references and angle axes:

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

Compare feedback requires side `a` or `b` and carries both package source hashes, both exact rig/motion identities, the shared video hash and animation. A changed input on either side or in the video refuses saved feedback until restart. State stays outside all source inputs. Single-package commands and sessions retain their existing contract. See [the comparison contract](REVIEW_PACKAGE.md#two-package-comparison).

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

This read-only command prints the session JSON, including reviewed artifact identity and feedback. The exact current-tool session wins when present. After a viewer/runtime upgrade, if that exact session is absent, the CLI can retrieve the latest saved submission over the same content with its original recorded versions and `retrieval: {kind:"prior-tools", toolsChangedSince:true, matchingSubmissions, currentTools}`. It does not migrate approval into the current UI or change saved bytes. Changed inputs still return a fresh pending session; a prior submission is never borrowed across content, revision or reviewed-artifact changes. The same lookup applies to `feedback compare`, preserving both recorded side bindings, reference identity and animation. See [historical retrieval](REVIEW_PACKAGE.md#historical-feedback-retrieval) for selection and validation rules.


For grouped issue-ready text, use the same input/reference binding with `--format issue`:

```sh
rig-review feedback /absolute/output --reference /absolute/original.mp4 --format issue
rig-review feedback /absolute/a --compare /absolute/b --reference /absolute/original.mp4 --animation dance --format issue
```

The header counts feedback records by defect/quality and by build; blocks group by category, then exact target kind/name. Overlapping intervals and A/B sides remain distinct items. Each block retains its id, inclusive interval, one-line summary and selected/full paired provenance. Historical tool identities and validation warnings remain visible; output never migrates approval, writes state or publishes an issue. Default output and `--format json` remain the existing session JSON. Only feedback accepts `--format`, with `json` or `issue` as its value. These two formats are how submitted feedback leaves the tool; the browser page offers no JSON or Markdown download.

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
rig-review open /absolute/output --config /absolute/output/rig/config.json [--parts /absolute/output/rig/out] [--source <png> --full <dir> [--head <dir>]] [--keypoints <file>]
rig-review feedback /absolute/output --config /absolute/output/rig/config.json
```

`--config`, `--parts`, `--source`, `--full`, `--head` and `--keypoints` declare the producer
handoff (see `docs/REVIEW_PACKAGE.md`, *Producer handoff*). They win over the
review.json `producer` block, which wins over discovery (`config.json`, then
`rig/config.json` inside the opened folder, then `../config.json` beside an opened
`out/`, named as discovered outside the folder). For the `check/` package of a
`rig-parts build` output the next places are the build's own config: `config.json`
in the build root, else beside it (`<out>/../config.json`, where `rig-parts build
--config <dir>/config.json --out <dir>/out` leaves it); the parts directory is the
build root. Declaring `--config` at exactly one of those two files is taken the same
way, and that file's folder is then the root for the other flags. Every other path must sit inside the
package root; a path outside it or a symlink that leaves it is refused by name.
The handoff files are hashed into the reviewed identity, so `feedback` and
`control` take the same flags to retrieve the same session, and changing the
config bytes starts a new pending review. `--keypoints` (#111) is the body-18 keypoint
file a cloth recipe Apply hands to `rig-parts propose`; it is hashed into the identity
only when declared, so a handoff without it keeps its identity. `--parts`,
`--source`/`--full`/`--head` and `--keypoints` need `--config`; `--source` and `--full` go together; compare takes none of them.

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
outside all input packages, judged by its canonical location (symlinks in the path
and its existing ancestors resolved). Existing foreground review commands still work.

No browser is opened, no LAN listener is added, and no misleading phone/QR URL is
printed: every current instance binds only `127.0.0.1`.

The printed feedback retrieval command uses POSIX shell quoting for literal path
arguments. It is not a PowerShell or cmd.exe command string.

### Launcher contract

A launcher may start `rig-review open` as a child process and rely on its stdout,
stderr and exit code alone:

1. On success stdout is exactly one line, the URL. `open` never writes anything
   else to stdout.
2. On success stderr carries the human lines in this fixed order: for the `check/`
   package of a `rig-parts build` output, `Package: rig-parts build check package <path>`
   and the handoff line (`Handoff <how>: <config path> sha256 <hash> · parts <dir>`, or
   `Handoff: <refusal>`); the animation diagnostic (when a clip is selected), the control notice (with `--control`),
   then the copyable retrieval line `Review started|reused; feedback: rig-review feedback …`.
3. A refusal exits with code 1, writes nothing to stdout, and its first stderr line
   starts with a name, followed by a colon and the explanation:
   - `OPEN_INPUT_MISSING <path>`: the input or `--compare` path does not exist, or is neither a directory nor a regular file.
   - `OPEN_INPUT_UNRECOGNIZED <path>`: the folder holds no recognized model, skeleton, motion, report, reference or pose sequence and is not a `rig-parts build` output root, or the file is not a JSON manifest.
   - `OPEN_REFERENCE_REQUIRED`: `--compare` was given without an explicit `--reference`.
   - `OPEN_ANIMATION_UNKNOWN <name>`: the explicit or report-named clip (JSON-quoted) is not in the compiled model.
   - `OPEN_ANIMATION_AMBIGUOUS`: no flag or report selects one clip, or the A/B reports conflict.
   - `OPEN_ANIMATION_UNVALIDATABLE`: a clip was requested but no compiled model can validate it.
   - `OPEN_OPTION_INVALID <flag>`: an unknown, duplicate, empty or value-less option, a handoff flag without `--config`, `--source` without `--full` (or the reverse), or a handoff flag with `--compare`.
   - `OPEN_STATE_INSIDE_PACKAGE <package | build root | handoff root>`: the state directory (`RIG_REVIEW_STATE_DIR` or the default), resolved through symlinks, lies inside an input package, the `rig-parts build` root a check package belongs to, or the producer handoff's root.
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
`pageId`/`revision`; it does not open a browser or start another worker. A page
learns from `GET /api/access` (`control: true|false`) whether its instance serves
control; an instance opened without `--control` is never asked for
`/api/control/config`. To change
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

