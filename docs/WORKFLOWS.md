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

Add `lang=en` or `lang=ko` to a review link's query to open it in that language, ahead of the fragment: `…/?checkpoint=silhouette&lang=en#cap=…`. It outranks the browser and the saved choice and stores nothing, so a shared link cannot change a reader's setting. Picking a language in the settings menu takes over for the rest of the page.

## Review parts before rigging
`rig-review parts <out>` opens a rig-parts build root's parts (`rig/parts.json` and `rig/parts/*.png`) before any rig is built: each part on a sentinel background, the footprints of the parts in front of it, the producer's flags on it, and a per-part sign-off written to `parts-review.json` for the create pipeline. `rig-review parts <out>/check` shows a built rig's atlas. See [Parts and atlas view](PARTS_VIEW.md).

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

The footer fits its measured text while retaining full hashes. Text is drawn in named families (mono: DejaVu Sans Mono, Liberation Mono, Menlo, Consolas; sans: DejaVu Sans, Liberation Sans, Helvetica, Arial), because Node Canvas resolves `monospace`/`sans-serif` to whatever family the machine lists first; with none of a list installed, export refuses `STRIP_FONT` before decoding or drawing. RGB/dark-tint features unsupported by the published Canvas2D path refuse with `STRIP_UNSUPPORTED_TINT`; they are not silently omitted.

## One-command owner handoff

`open` validates and hashes designated folders, starts or reuses one background
loopback owner workspace, prints its owner URL, and exits. **N rigs → one
invocation, one owner link.** Targets share one listener-owning process and port.
The default port is `127.0.0.1:4318`; `RIG_REVIEW_FRONT_PORT` selects an explicit
port. The URL has the form `http://127.0.0.1:4318/?workspace=<incarnation>#cap=…`; keep its capability
private and give the person one link plus one what-to-look-at line.

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
approves a review. Retrieve submitted feedback with the original per-target input and handoff
arguments; stdout contains the owner URL alone. The workspace summary on stderr
does not print a per-target feedback command. A selected external video takes precedence
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

### Multiple targets and repeated open

`--animation` supplies the default clip for every target. Repeat
`--animation-for <index> <name>` to override distinct 1-based target positions.
This opens nine rigs, selecting `walk` for `dirB` and `idle` for the others.

```sh
rig-review open dirA dirB dirC dirD dirE dirF dirG dirH dirI \
  --animation idle --animation-for 2 walk --view-only
```

Indices outside the target list, invalid indices and duplicate overrides refuse
with `OPEN_OPTION_INVALID`. Common typed options apply to each target and retain
their existing validation. Each animation is validated against its own model.
A single primary target can use `--compare <other-dir>` with an explicit
`--reference <video>`; a multi-target batch with `--compare` is refused.
`--direct` accepts one primary target only.

Compatible repeated opens add to the same owner list and print the same root
owner URL, including its owner capability within that host incarnation. They exit
0 and add no listener or resident per-rig worker.

```sh
rig-review open dirA --animation idle --view-only
rig-review open dirB --animation walk --view-only
rig-review feedback dirA --animation idle --format json
```

A consumer opened N rigs with N sequential `open` calls. Use the batch form when
all targets are known together. Duplicate compatible registrations reuse the
entry; conflicting options refuse with `WORKSPACE_TARGET_OPTIONS_MISMATCH`.
The owner selects targets from the list. `--view-only` entries are labelled
**Inspection only** and have no semantic act or pending approval. Existing
feedback semantics still apply within each inspection. Retrieve submitted
feedback using each target's exact original inputs, references and handoff
arguments. A shared owner URL supplies no feedback identity or approval.

Inspection frames load on selection and remain retained for their target's
camera, time, selected part/panel and source-bound draft. Switching pauses hidden
playback. Reviewer-authored words remain verbatim. Admission and retained frames
share a 32-target application limit. Adding target 33 refuses atomically with
`WORKSPACE_TARGET_LIMIT`, preserving the existing registrations. This bound is
an application limit, not a hardware memory or performance guarantee.

### Workspace lifecycle and restart

The workspace owns one aggregate live lifecycle, shared by the owner page and
its target contexts. Target contexts have no independent server shutdown timers.
After all live connections close, the workspace waits the 3-second grace period
and for registrations, active response streams and target work to finish before
stopping. A workspace with no connected page has a 30-minute unopened window;
a successful registration re-arms that window when no page is connected.
These timers apply to the whole workspace. The separate per-instance behavior is
preserved under [Direct server and legacy lifecycle](#direct-server-and-legacy-lifecycle).

Reuse requires the same UID, installation, runtime and fingerprint, the designated
port and an authenticated live-host response. Mismatches refuse with
`WORKSPACE_OWNER_MISMATCH` or `WORKSPACE_HOST_MISMATCH`. A live but unresponsive
PID refuses with `WORKSPACE_HOST_UNRESPONSIVE`; a timeout leaves its ownership
intact. Concurrent launchers coordinate registration through the private store.

Restart creates a new host incarnation and rotates owner, launcher and target
secrets. The nonsecret `workspace` query changes with the incarnation, so opening
the new link in an existing tab loads a new document. Repeated opens within one
incarnation retain the same URL. Run `open` again and give the person the new
owner link. A supplied `workspace` query must match the current host; root links
without it remain accepted. Persisted input
designations are revalidated. Changed sources appear unavailable with
`WORKSPACE_SOURCE_CHANGED`; saved feedback and drafts retain their original
source binding. Registering another valid target remains possible when an
unrelated target's source has changed.

If a legacy front or another listener occupies the chosen port, launch refuses
with `FRONT_PORT_BUSY` and the instruction `use --direct` or set
`RIG_REVIEW_FRONT_PORT` explicitly. For example, choose another workspace port
with `RIG_REVIEW_FRONT_PORT=4320 rig-review open dirA --view-only`.
Leave existing workers and listeners under their current owner's control.

Workspace descriptors, designations, startup requests and logs live under
`<state>/owner-workspace/`, with private owner/launcher credentials and distinct
target capabilities. State stays outside every input package. Loopback-only,
same-origin bounded JSON mutations and contained package paths remain required.
Registration carries designated package inputs. Agents use supported commands
and APIs and never construct internal Review state or human acts.

### Subsequent CLI and semantic paths

Plain multi-target review starts a workspace in the foreground CLI process:

```sh
rig-review dirA dirB --animation idle --animation-for 2 walk --view-only
```

A new owner prints `Review ready: <owner URL>` and stays in that terminal. Its
SIGINT/SIGTERM handlers await shutdown of the one listener and its contexts.
The same aggregate last-window and unopened timers described above apply.
A compatible active workspace receives the batch instead; that launcher prints
only the identical owner URL and exits 0 without acquiring stop ownership.
`open` and foreground multi can join each other's owner. Registration retains
its atomic validation, source identities and bounded target list.

Multi uses managed port 4318, or `RIG_REVIEW_FRONT_PORT`, with explicit `--port`
precedence. Its port range is 1..65535; `--port 0` refuses with
`OPEN_OPTION_INVALID`. Existing single foreground remains on 4317 and accepts
`--port 0`; existing `compare` behavior is unchanged.

`--animation` is common to all operands and 1-based `--animation-for INDEX NAME`
overrides one operand. Each target uses its explicit selection, report animation,
or unique actual clip; ambiguity refuses by name. Static/source-only inspections
retain their existing support. Multi accepts common reference/handoff flags,
`--view-only` and `--control`. Its exact inputs work with the existing feedback
and control commands. Multi checkpoint, batch compare, direct and project/joined
options refuse with `OPEN_OPTION_INVALID`; existing single options retain their
behavior. Flags and their literal values are consumed before counting operands.
Core's `rigc review` continues forwarding to `open`; Review owns this grammar.

The embedded semantic-job hub also remains pending. Its same-process host will
own trusted `readPublished`, `partsEnumerator` and `installWriterBinding`
callbacks. General cross-process callback transport is deferred. Each job retains
independent source, reviewer, capabilities, generation CAS, cursor, displayed
acknowledgment and writer grant under job-api@2/act@2. Registration-handle detach,
host stop and semantic close remain separate lifecycle concerns. Follow the
current [standing live-job workflow](#standing-live-job-workflow) and
[public host contract](STABILITY.md#managed-owner-host) for semantic jobs.

### Launcher contract

A launcher may start `rig-review open` as a child process and rely on its stdout,
stderr and exit code alone:

1. On success stdout is exactly one line, the URL. `open` never writes anything
   else to stdout.
2. Managed workspace success writes per-target package/handoff and animation
   diagnostics in target order, then `Review workspace started|reused; N target(s).
   Retrieve feedback using the original input designation.` The direct-server
   path retains the following stderr order. For the `check/`
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
   - `OPEN_OPTION_INVALID <flag>`: an unknown, duplicate, empty or value-less option, an invalid/out-of-range/duplicate `--animation-for` index, multi-target `--compare` or `--direct`, a handoff flag without `--config`, `--source` without `--full` (or the reverse), or a handoff flag with `--compare`.
   - `OPEN_STATE_INSIDE_PACKAGE <package | build root | handoff root>`: the state directory (`RIG_REVIEW_STATE_DIR` or the default), resolved through symlinks, lies inside an input package, the `rig-parts build` root a check package belongs to, or the producer handoff's root.
   - `OPEN_HANDOFF_INVALID <flag or path>`: a declared or discovered producer handoff path is refused — `HANDOFF_PATH_OUTSIDE_ROOT`, `HANDOFF_SYMLINK_ESCAPE`, `HANDOFF_INPUT_MISSING`, `HANDOFF_INPUT_INVALID` or `HANDOFF_PATH_INVALID`, named after the colon.
4. Exit codes: 0 applied, 1 refused. (`control` keeps its own exit 2 for an
   unapplied command.)

Input validation precedes workspace registration. Workspace startup and
registration refusals retain their named codes and exit 1. A refused batch
registration leaves existing registrations intact. Direct-worker refusals keep
their existing messages.

### Direct server and legacy lifecycle

Use `rig-review open dirA --direct --animation idle --view-only` for a separate
single-target server. It prints the worker's own URL and retains the per-instance
lifecycle and hash-bound handoff described here. Foreground `review` and
`review compare` retain their existing separate-server behavior.

Only tool-owned instances with matching content, canonical input locations, tool
fingerprint and a private capability handshake are reused. The URL hash is
checked before serving the app; a stale link never selects another instance's
package. Input hashes are freshly computed, not trusted from mtime caches. In both
`open --direct` and foreground `review` / `review compare`, each open window holds a live
WebSocket connection (`/api/live`); once the last window closes and stays at zero connections
for the 3-second grace period, or if no window ever connects within 30 minutes
(reusing a windowless worker via `open --direct` gives it a fresh 30-minute unopened window),
the server finishes any in-flight request or Apply, flushes state, prints one line
stating why it exited, and exits `0`. A browser that unloads a background tab to
save memory looks the same as a closed tab, so the server stops; saved feedback
survives and `open --direct` brings it back. Their
private registry, requests and logs live beside feedback under
`~/.local/state/rig-c-review/open/`; nothing is written into supplied folders. `RIG_REVIEW_STATE_DIR` selects another state root
outside all input packages, judged by its canonical location (symlinks in the path
and its existing ancestors resolved). Existing foreground review commands still work.

No browser is opened, no LAN listener is added, and no misleading phone/QR URL is
printed: every current instance binds only `127.0.0.1`.

The printed feedback retrieval command uses POSIX shell quoting for literal path
arguments. It is not a PowerShell or cmd.exe command string.

### Managed front and write capability

This heading preserves the legacy per-instance managed-front reference. Current
default `open` uses the [owner workspace](#one-command-owner-handoff).
`open --direct` serves its worker directly.

#### Legacy per-instance proxy

The earlier managed launcher ensured one detached loopback front at
`127.0.0.1:4318` (`RIG_REVIEW_FRONT_PORT` overrides) for the state directory and
printed `http://127.0.0.1:4318/instances/<key>/?input=…&handoff=…#cap=…`. Every
inspection therefore shares one stable browser origin, so Settings, panel sizes and
source-bound drafts survive a reopen. The front only routes: it takes the worker
address from that key's private open record, allows a closed per-method route
list, bounds bodies (16 KiB control, 1 MiB session/strip) and upstream time,
limits concurrent upstream streams, re-verifies the worker's nonce on every
request, and refuses an unknown, expired or replaced instance by name
(`FRONT_INSTANCE_UNKNOWN`, `FRONT_INSTANCE_EXPIRED`, `FRONT_INSTANCE_REPLACED`).
Worker error text is not passed through; failures become named `FRONT_*` codes.
Package assets keep their `sandbox` CSP through the front. It never reads packages.
Idle fronts exit after the 3-second grace period once no live instance remains.

If another listener holds the front port, `open` fails with
`FRONT_PORT_BUSY: 127.0.0.1:4318 is held by another listener; use --direct` and
does not fall back silently. `open --direct` keeps the per-instance port and
prints that worker's own URL.

#### Direct and legacy write capability

One origin cannot isolate scripts that run on it, so writes are bound to a
per-instance capability rather than to the page's origin or the key in its path.
Each worker mints a 256-bit capability kept only in its private 0600 open record.
The legacy managed launcher, `open --direct` and the foreground `review`/`review compare` commands
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
edit*; run `open --direct` again for a writable per-instance link. Current workspace
owner links use the separate incarnation-bound capability described above.

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
existing ordinary servers do not become controllable. Registering the opted-in target
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


## Comment on a detail

On the view you are inspecting, choose **Comment · C (n)**, drag over the detail (or click a point), type, and press Enter. Turning **Comment · C (n)** on enters comment mode and opens the comment list; turning it off or pressing Escape leaves both. Click a pin on the stage or a row in the list to restore its captured pose and open that comment in the same composer to edit or delete before submitting through the existing review flow (submitted marks open read-only, and under a capture refusal the button still opens the list read-only). No target, interval or category form is required. [Panel behavior](PANELS.md#stage-comments) explains pins, crop fitting and frame availability.

`rig-review feedback <input> --format json` and `--format issue` retain these comments in the existing feedback report. Compare uses the same A/B/reference/animation arguments as its open command. Each comment includes source hashes, viewport, frame basis, animation, `context.turn`, camera, screen/world region, nearest-first drawn slots, and crop path/SHA-256/dimensions. Derived CLI reports omit the inline PNG; the private draft and submitted session retain it. The CLI resolves the PNG's derived crop path under the review state directory so an agent can open it without a browser. Crop files are created on submission, outside the input package. Unsubmitted UI drafts stay local. No comment field or output byte is added to a review without comments.

The four-stage navigator preserves this entry and its explicit save behavior. Compiled sessions reuse the atlas surface read-only; see [Four inspection stages](PANELS.md#four-inspection-stages).

The managed front forwards only the trusted stage-atlas frame query (`stageEmbed=1`, `lang=en|ko`, and a required `side=a|b` for compare; no side for single). Unknown or duplicate keys are refused; the frame carries no filesystem path, command or capability. Stage navigation never changes CLI arguments or package bindings.

## Standing live job workflow

The active Create and Parts inspection cycle uses the semantic job contract in `src/job-contract.ts` (`JOB_API_SCHEMA` set to `rig-review/job-api@2`, `JOB_ACT_SCHEMA` set to `rig-review/act@2`, [Review #484](https://github.com/rig-c/review/issues/484)) together with the implemented backend session/store (`src/job-session.ts`, `src/job-source.ts`, `src/job-act.ts`, `src/job-api.ts`), loopback job front and browser window runtime (`src/job-front.ts`, `web/job-session.ts`), and `rig-review session` CLI (`src/entry.ts`, `src/job-cli.ts`). The public installed managed-host entry is `@rig-c/review/job-host` with frozen exports in [Public API stability](STABILITY.md#managed-owner-host), and Create's production publication reader and writer-owned sibling `fetch-act` readback remain pending [Create #184](https://github.com/rig-c/create/issues/184) (publishing a Create root containing `project.json` without a host `readPublished` callback refuses `JOB_SOURCE_UNRETAINABLE` with `CREATE_PUBLICATION_CONTRACT_UNAVAILABLE`). See [Live job contract](REVIEW_PACKAGE.md#live-job-contract) for the full schema and host seam reference.

Exact CLI usage from `src/entry.ts` and `src/job-cli.ts` (`publish`, `ask`, `next` and `close` also accept optional `--request-id <id>`):

```text
Usage: rig-review session open <root>
       rig-review session publish <job-url> --generation <n> --key <id> --result <relative-path> --freeze-hold <id> [--selector <JSON>] [--record <path> --record-hash <sha256>]
       rig-review session ask <job-url> --generation <n> --key <id> --publication <id> --subject <JSON>
       rig-review session next <job-url> [--after <cursor>] [--wait-ms <n>]
       rig-review session close <job-url> --generation <n> --key <id> --reason <words>
```

`rig-review session --help` prints this usage (`src/entry.ts` dispatches only the `session` namespace to the live-job CLI and delegates all other argv and exit behavior to `src/cli.ts`). `rig-review session open <root>` requires `RIG_REVIEW_JOB_REVIEWER_ID` and `RIG_REVIEW_JOB_REVIEWER_ROLE` (`owner` or `delegate`; missing or invalid values refuse with `JOB_AUTHORITY_REFUSED`), accepts optional `RIG_REVIEW_JOB_PORT` (`0..65535`), and optionally writes one private `{jobId, origin, agentCapability}` JSON line to an inherited writable descriptor `>= 3` named by `RIG_REVIEW_JOB_AGENT_FD` before printing the standing owner URL on stdout. A standing job survives zero open owner tabs; a later `session open` on the same root reuses the active job/link and exits, while the initial listener stays attached until `SIGINT`/`SIGTERM` or until an explicit `close` event ends the job incarnation. The owner HTML root (`/jobs/<jobId>/`) accepts the default or literal `?lang=en` or `?lang=ko` and refuses other or duplicate queries (`JOB_REQUEST_INVALID`). Agent verbs authenticate with `RIG_REVIEW_JOB_AGENT_CAPABILITY` (`Authorization: Bearer …`) against `<origin>/jobs/<jobId>`. Ordinary non-Create package launch, publish, ask, poll and explicit close example (capabilities stay in private descriptors/env and are never printed in logs or reports):

```sh
# Terminal 1 — create a private bootstrap directory (umask 077) and keep the new listener in the foreground:
boot=$(umask 077 && mktemp -d)
RIG_REVIEW_JOB_REVIEWER_ID=owner-1 \
  RIG_REVIEW_JOB_REVIEWER_ROLE=owner \
  RIG_REVIEW_JOB_AGENT_FD=3 \
  rig-review session open /absolute/path/to/work-root 3>"$boot/bootstrap.json"

# Terminal 2 — with RIG_REVIEW_JOB_AGENT_CAPABILITY set privately from $boot/bootstrap.json:
rig-review session publish http://127.0.0.1:<port>/jobs/<job-id> \
  --generation 0 --key pub-1 --result package --freeze-hold hold-1 \
  --selector '{"kind":"rig","version":1}'
rig-review session ask http://127.0.0.1:<port>/jobs/<job-id> \
  --generation 1 --key ask-1 --publication <publication-id> \
  --subject '{"kind":"review-verdict","stage":"rig-review"}'
rig-review session next http://127.0.0.1:<port>/jobs/<job-id> --wait-ms 5000
# Pass the current generation returned by next (human UI acts advance generation):
rig-review session close http://127.0.0.1:<port>/jobs/<job-id> \
  --generation <current-generation> --key close-1 --reason "inspection complete"
```

- **One standing window and visual gate.** Every owner visual, question, choice, correction and verdict goes through one standing Review window/link plus one what-to-look-at line. Internal agent and HQ media stay internal and are never substituted for the owner handoff. When a required visual is missing (`visual.status` set to `'unavailable'` with a named `code`), the agent stops immediately and files a Create on-path Review card rather than falling back to chat text or images.
- **Human UI vs agent verbs.** People submit through the Review browser UI (`actor` set to `'human'`, `channel` set to `'review-ui'`). Trusted host bootstrap declares `reviewer` (`id` and `role` as `'owner'` or `'delegate'`), which the browser UI cannot type or override. This binding records bootstrap-declared provenance rather than keyboard-user authentication, and Create maps `role` to its existing `by` authority. Agents use only `publish`, `ask`, `next` and `close` (`JobAgentRequest`), with `expectedGeneration` compare-and-swap (CAS) and `idempotencyKey` on mutations.
- **Explicit producer-held freeze and explicit close.** Every `publish` request designates a root-relative `result` (`path` and `selector`, never a command) and carries an explicit producer-held freeze (`freeze.kind` set to `'producer-held'`, `holdId`, `record` as `JobFileIdentity` or `null` for a declared non-Create root) held until acknowledgment. Review validates retained bytes, detects a moved record (`JOB_RECORD_MOVED`, `JOB_RECORD_INCOMPLETE`, `JOB_FREEZE_REQUIRED`, `JOB_SOURCE_MISMATCH`, `JOB_SOURCE_UNRETAINABLE`, `JOB_ROOT_REPLACED`) and commits local generation CAS (`JOB_GENERATION_STALE`, `JOB_IDEMPOTENCY_CONFLICT`). The freeze assertion is a caller obligation rather than a lock Review can impose on independent writers. Review offers no watched-root or automatic-close guarantee, and only explicit `close` ends an active job.
- **Exact displayed source and retained drafts.** The daemon derives `JobSourceBinding` from validated retained bytes and the actual displayed publication (`ackDisplayed` returning a page-scoped `displayedNonce` receipt, pinned same-origin `routes` with no mutable current alias). All metadata, images, runtime assets, routes and pending form dependencies prepare before the visible swap; paint and the single `displayedNonce` acknowledgment precede retirement of the previous view, and failed preparation or acknowledgment restores the prior view and draft. Clients never supply trusted source hashes or transfer prior approval onto a new binding. When a new publication updates the displayed source, old local drafts remain retained in storage for their original source binding and are flagged without rebinding onto the new publication.
- **Finalized acts, five enabled kinds and cursor replay.** `next` (`after` cursor and bounded abortable `waitMs` that never consumes an act) and `subscribeJob` replay complete durable `JobEvent` records (`published`, `pending`, `act`, `closed`). Only five act kinds are enabled (`interview-picks`, `checkpoint`, `parts-verdict`, `review-verdict`, `signoff`). `described-correction` (awaiting the joint [Create #182](https://github.com/rig-c/create/issues/182) context allowlist) and `mesh-edit` (awaiting the joint [Parts #1159](https://github.com/rig-c/parts/issues/1159) freeze) stay reserved and disabled (`JOB_ACT_KIND_DISABLED`).
- **Checkpoints, signoffs, plan steps and parts PNGs.** In `checkpoint` acts, `outcome` is `'pass'` or `'fail'` only (`'pending'` stays in the UI draft and never produces a finalized act), and required `words` is preserved verbatim as a string including empty or whitespace-only text. The browser sends `checkpointId`, `outcome` and `words` only while the daemon copies resolved `planStepId` from the validated ask, and Create derives execution stage from its authoritative step phase and order without Review stamping a stage. Only `'pass'` is eligible for Create's checkpoint sign-off writer, while `'fail'` is feedback or a named consumer refusal. In `signoff` acts, `decision` is `'approved'` only (changes requested are a verdict) with required `words` preserved verbatim including empty or whitespace-only text. A verdict, a signoff and a Create stage transition are three separate writes, and plan-bound signoff stages (`plan-approved`, `rigging-interview`, `post-interview`) require `source.plan` with exact displayed step IDs and hashes published by [Create #184](https://github.com/rig-c/create/issues/184) without Review recomputing `stepHash`. C4 binds the exact public `partsFileReferences(dir)` array from `@rig-c/parts/src/parts.ts`, whose contract is frozen at Parts 2.25.0. The trusted host resolves an installed version in `JOB_PARTS_ENUMERATOR_RANGE` (`>=2.25.0 <3.0.0`), supplies its actual version and official callback through `partsEnumerator`, and declares `partsEnumeratorId`. `JobPartsIdentity.enumeratorVersion` carries that actual version. Manifest paths are work-root-relative and image paths are relative to the manifest directory. Each image carries `path`, bounded-string `role` and raw-byte `sha256`. Review compares the claimed array positionally with the official array, preserving its role/order/duplicate semantics. Upstream roles include `part`, `alternate`, `depth`, `painting` and `figure_mask`. Review bounds shape and paths, refuses traversal/symlinks, decodes PNGs and hashes retained bytes. Missing references refuse with row, role and path, including a missing sibling figure mask when a render copy exists. Unreferenced extras stay outside this parts identity. Composite source hashes use `rig-review-job-source/2`. Create #184 production reader/projection and official-hook wiring remain pending.
- **No agent file carriage, writer-owned sibling fetch and public host seam.** Agents never build, parse, reshape or carry Review session, picks, verdict or applied-record storage files. [Create #182](https://github.com/rig-c/create/issues/182) and [Create #184](https://github.com/rig-c/create/issues/184) own direct writer publication and act fetch through a private writer-owned sibling binding outside `project.json` (`writer-owned-sibling-fetch-capability`, pending Create #184 production reader/writer integration). That binding is never tracked in version control or unstaged project output, dies at explicit `close` with a new grant per job incarnation, and grants read-only `fetch-act` over loopback with `Authorization`. In the public managed-host startup seam (`startJobHost` from `@rig-c/review/job-host`, frozen in [Public API stability](STABILITY.md#managed-owner-host)), hook-bearing host callers declare `readerId` for `readPublished` and `bindingId` for `installWriterBinding` and `partsEnumeratorId` for `partsEnumerator`; missing or invalid IDs refuse with `JOB_HOST_OPTION_ID_INVALID`, and listener reuse requires equal `readerId`, `bindingId` and `partsEnumeratorId` or refuses with `JOB_HOST_REUSE_MISMATCH` (with no function hashes). Future mesh-edit consumption is owned by [Parts #1159](https://github.com/rig-c/parts/issues/1159), where Create fetches a finalized mesh act and passes its typed value in process to Parts' public exported API without Parts reading Review or Create storage.
- **Direction metadata vs playback.** Direction carriage in `#484` is metadata-only (`source.direction` and `direction-review`) and is distinct from [Review #482](https://github.com/rig-c/review/issues/482) preview and [Review #483](https://github.com/rig-c/review/issues/483) actual plated take playback, while [Review #373](https://github.com/rig-c/review/issues/373) stays parked.

## Create choice interview

In the active standing live-job cycle ([Standing live job workflow](#standing-live-job-workflow), [Create #182](https://github.com/rig-c/create/issues/182), [Create #184](https://github.com/rig-c/create/issues/184)), interview choices and parts verdicts use the semantic job API (`interview-picks` and `parts-verdict` acts fetched directly by the Create writer via its private sibling capability). The `--picks-dir`, `--picks-file`, `--parts-verdict-dir` and saved verdict path commands below are preserved as legacy/history one-shot handoff documentation and are bypass findings if used in the active cycle.

Open the interview beside its separated parts in the standard inspection host.
Use the materialized Create review package and designate the exact project and
rig version. The picks directory must already exist inside the project and be
separate from its inputs.

```sh
rig-review open /path/to/project/derived/review/v2/out \
  --project /path/to/project --project-version 2 --picks-dir scratch/review-picks
```

Select **2 Interview**. The host checks the recorded version's package
inventory and pins the project digest and inspected source. A different
project or version returns `INTERVIEW_SOURCE_MISMATCH`. A changed input
requires reopening and a project without interview content reports
`INTERVIEW_UNAVAILABLE`. Navigation retains the open form and part selection.
Use **Save explicit picks** to persist pending choices. Historical answers
remain read-only and opening or saving picks does not sign off any stage.

To inspect authored direction in **4 Direction**, add `--post-version <post>`
to the joined command. The post must explicitly name the selected
`--project-version` rig and bind an authored direction document. Reuse the
printed feedback command, including the project, rig, post and picks arguments,
to export from that session.

### Open a recorded draft before rig review

In the active standing live-job cycle ([Standing live job workflow](#standing-live-job-workflow), [Create #182](https://github.com/rig-c/create/issues/182), [Create #184](https://github.com/rig-c/create/issues/184)), draft parts and mesh verdicts are submitted as `parts-verdict` acts over the semantic job API and fetched directly by the Create writer. The `--picks-dir`, `--parts-verdict-dir` and `--picks-file` commands below are preserved as legacy/history one-shot handoffs and are bypass findings if used in the active cycle.

Select a Create draft explicitly and open its recorded compiled check directory.
Create the picks directory and, for a pending parts verdict, a separate verdict
directory inside the project before opening the host.

```sh
rig-review open /path/to/project/derived/drafts/chain/out/check \
  --project /path/to/project --project-draft chain --picks-dir scratch/review-picks \
  --parts-verdict-dir scratch/review-verdicts
```

**1 Parts + mesh** displays the draft's recorded parts and matching mesh.
Use **Save sign-off** to write a standard parts verdict with the part and mesh
outcomes and notes. Its filename is bound to the inspected project and source.
Keep the JSON file at its saved location for Create to resolve the source paths.
The verdict does not sign the Create project. A closed parts review or an open
without `--parts-verdict-dir` keeps this surface read-only. **2 Interview**
offers the registered pending sets and displays historical answers read-only.
**3 Rig + animation** and **4 Direction** report that the recorded rig review
package is unavailable. Reopen with a rig version once Create records one.

From a create project with retained choice sets, create a dedicated output
directory and open the foreground Stage 2 view:

```sh
mkdir -p scratch/review-picks
rig-review interview . --picks-dir scratch/review-picks
```

Open the printed loopback URL. Select a question and inspect its bound parts
or source image. A direction set that binds only source inputs displays those
inputs with the no-bound-parts notice. Each recommendation shows the retained
reason and author/date. Choose an option for every prompt and save explicitly.
Other records your wording and stays pending until a tailored choice is
offered and picked. Auto stays pending until create has a covered agent
decision. Historical choice sets are read-only.

Each saved set has its own `<raw-set-sha256>.json` in the designated directory.
Reopening restores picks and note for the same retained set. A new set starts
without selections. The directory must exist inside the project and be
separate from every bound input. A stale context, forged selection or
superseded set is refused. Review writes only `rig-review/interview-picks@1`
files. To ingest a file, run create separately from the project root:

```sh
rig-create interview-answer <question> . --picks-file scratch/review-picks/<raw-set-sha256>.json
```

Part assets must be valid images as well as hash-bound. A bound PNG without a
PNG signature returns `INTERVIEW_IMAGE_INVALID`. The panel displays a named
refusal when the browser cannot display a bound image.

## Correction handoff

In the active standing live-job cycle ([Standing live job workflow](#standing-live-job-workflow), [Create #182](https://github.com/rig-c/create/issues/182), [Create #184](https://github.com/rig-c/create/issues/184), [Parts #1159](https://github.com/rig-c/parts/issues/1159)), `described-correction` and `mesh-edit` remain reserved disabled act kinds (`JOB_ACT_KIND_DISABLED`), and agents never build, parse, reshape or carry Review session, feedback, applied-record or verbatim files. The `--correction`, `--feedback-file`, reshaped feedback JSON and `--verbatim-file` commands below are preserved as legacy/history one-shot handoffs and are bypass findings if used in the active cycle.

In **Write review**, choose described or made under **Correction handoff** and
supply the Create review stage and its draft ID or version. A direction-review
version also needs its declared post model path. Add the feedback and submit.
A described request stays unresolved. An optional UTF-8 text file supplies
exact words, including trailing spaces and CRLF. To use an unsent pointed
comment, fill the Create identity and select **Use as described correction**
on its row.

```sh
rig-review feedback <review-package> --correction <saved-item-id> --format issue
rig-review feedback <review-package> --correction <saved-item-id> --format json
```

The issue shows the source selector, exact words and evidence. JSON emits the
original saved single-package session. Pass that retained session and item ID
to Create's `correction record --feedback-file … --item …` for supported made
corrections. For a described request, retain the words as UTF-8 and pass them
to `correction record --verbatim-file …`. Create owns the record and outcome.
A missing or stale result refuses a checked handoff. Mesh deltas, retarget
operations and keyed operations retain their original evidence and report
`CORRECTION_OPERATION_UNSUPPORTED`. Compare sessions remain ordinary evidence.

Standalone parts notes and comments use
`rig-review parts <parts> --format issue --correction <id> --parts-file <inventory>`.
For a part note, also pass `--part-note <part>` and supply its correction ID.
Selected parts JSON keeps the saved verdict and adds the correction selection.
The inventory names a retained Create-side input. Review does not read that path.

## Four-stage acceptance fixture

The explicit browser runner in the Review checkout walks four independent Create
checkpoint prefixes using the managed loopback route for every stage and the
independent replay. The direct-route Save defect is tracked in
[Review #443](https://github.com/rig-c/review/issues/443).
Its inputs come from one archive of Create
[a1a5162](https://github.com/rig-c/create/commit/a1a5162cf4ce7fdef8caba50dc3979cf416467dd)
with SHA-256
`68034a42a70765ddda434195b945c9d87da85cf86443c657c31848ee163a8096`.
The materializer verifies the archive and each checkpoint sidecar before using
disposable copies. Checkpoint commands identify the declared acts and option
sets. The runner calls selected public consumers with explicit arguments.

Run `bun tests/four-stage-browser.ts` in a bounded Nova job from the Review
checkout after installing its frozen lock. Supply the original archive in
`REVIEW_371_CREATE_ARCHIVE`, the directory with Create's frozen-lock
`node_modules` in `REVIEW_371_CREATE_BENCH`, a new evidence directory in
`REVIEW_371_OUTPUT`, and the retained Stage 3 failed Apply JSON in
`REVIEW_371_FAILED_APPLIED`. The runner checks the failed artifact digest.
Keep Chromium's child `TMPDIR` short (the runner uses `/tmp` during launch).
The profile, Review state, input copies and producer scratch belong to the job.
The runner defaults to English followed by Korean. For a gated run, launch
`bash tests/four-stage-job.sh en` with the same pinned inputs, then launch
`bash tests/four-stage-job.sh ko` after accepting the English result. Each job
has a 600-second command deadline and uses a new evidence directory. The
`walk-checkpoints.jsonl` file records the last step entered if a run stops.

1. Save and export the pre-rig parts and mesh verdict through the joined Review
   surface. Create's shared parts-verdict checker verifies the actual saved
   artifact. The next prefix already has a signature bound to its original
   synthetic verdict.
2. Save the explicit bones picks, then register and answer meshes, constraints
   and motion in the generator's order. Refresh the joined view on identity
   changes and check each answer and exact note in Create.
3. Preview and Apply the body idle amplitude change from 0.5 to 2.5. The check
   must pass with at least 6.12/255 torso breath heat. Export the made correction
   and read back the Create config-patch record in its pending state. Replay the
   exported patch in separate Review scratch. The measured 0.75 failed-check
   control uses the refused UI request for a separate pending capture and
   checked-claim refusal. It writes no resolved outcome.
4. Write and check post 2 through Create on its pending prefix, then open rig 1
   with explicit post 2. Inspect the authored keys and timing, exercise the
   named camera Apply refusal, and save the described request. Verify the
   inspected and project-relative model bindings and Create's pending readback.
   The Create writer checks the explicit model selector and stores the exported
   context string verbatim.

Both locales have browser captures. The runner checks original inventories
against each copy after the walk, retains named public record changes separately,
and records the first consumer verdict for each planted mutation. Inspecting,
navigating and saving a Review draft produce no Create signoff.
