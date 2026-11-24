# Review package and existing-folder adapter v1

The toolchain delivery flow is **Create → Parts → Pose → Core (rigc) → Review → Play →
Adapter**. Review supplies human inspection and feedback bound to the exact
reviewed sources; it neither replaces Core's build validation nor authors motion.
The app uses the published `@rig-c/play` loader/player to preview artifacts during
that inspection. This conceptual delivery order is not an import/dependency
order. Adapter means downstream consumer integration through the published
`@rig-c/pixi`, `@rig-c/phaser` and `@rig-c/three` packages; Review does not depend
on them. Existing producer formats and playback dependencies
remain authoritative.

The CLI also accepts an existing output directory. It reads a root `review.json` when present. Otherwise it constructs this contract in memory: optional root `skeleton.model.json`, otherwise the fixed rigc build path `build/skeleton.model.json`; read-only `skeleton.*`, `motion.json` and `report.json` links; root videos (`mp4`, `webm`, `mov`); image filenames containing strip/contact/sheet/filmstrip/띠; and canonical `*pose*.json` references. The root compiled model takes precedence over the build path. These are the only two automatically recognized model paths; discovery never searches recursively. One fixed layout redirects instead (#149): a folder with neither model path that is a `rig-parts build` output root — regular `parts.json` and `rig/rig.json`, a real (not symlinked) `check/` directory, and an existing `check/build/skeleton.model.json` entry — opens as its `check/` package. The package root is then `check/`, exactly as if `check/` had been opened: the same manifest, source hash, `reviewedSource`, session and open key. A folder missing any of those files is not a build root and is refused or adapted as before; a build root that also holds a model of its own opens as itself. The opened directory remains the package root, so root motion/references accompany the build model and its model-relative pages. An existing selected model with an invalid type, dangling symlink, escaping symlink or invalid model envelope is refused rather than skipped. Each reference is shown separately; no source relationship, FPS or video synchronization is inferred. When the producer handoff knows the source painting (#329: a declared `source`, or `painting.png` beside a discovered config — *Producer handoff*, below), that painting is the first reference, labelled `Original painting · <file name>`, and the first checkpoint, so it is the reference selected on open; the contact sheet and every other adapted reference follow it unchanged. It sits outside the package, so it is never a package asset: it is served at the fixed read-only route `/review-painting` (the managed front passes it through for single reviews) by the SHA-256 pinned at load (a changed file is refused, HTTP 409), and `/api/review` names it as `sourcePainting: {id, path, sha256, url}` with the record's relative path. Its hash enters `sourceHash` and the handoff record, so changed painting bytes start a new session. When the handoff knows no painting, the references, checkpoints and source hash are exactly what they were before. A review.json package keeps its own checkpoints: the painting is listed first and is selected on open only when the first checkpoint names no reference. It never inserts or rewrites a manifest or motion file in the source folder. Raw Spine JSON/skel remains read-only evidence with playback unavailable. The folder revision is `folder-adapter/1`; actual changed file bytes are distinguished by the source hash.

`review.json` is UTF-8 JSON. Its directory is the package root. Required keys are `schema: "rig-review/1"`, `id`, `title`, and `revision`. `id` and every entry ID match `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`. Titles and revision strings are nonempty. Optional collections normalize to empty arrays.

```json
{
  "schema": "rig-review/1",
  "id": "rig-name",
  "title": "Rig name · revision 2",
  "revision": "2",
  "model": "build/skeleton.model.json",
  "motion": "motion.json",
  "references": [{"id":"source","label":"Original","type":"image","path":"source.png"}],
  "animations": [{"id":"idle","label":"Idle","duration":2}],
  "checkpoints": [{"id":"silhouette","title":"Inspect contour","workspace":"modeling","reference":"source","animation":"idle","time":0}],
  "authoring": [{"label":"Rig source","path":"rig.json"}],
  "axes": [{"id":"yaw","label":"Yaw","animation":"look","min":-30,"max":30}],
  "audio": {"clips":[{"id":"voice","path":"audio/voice.wav"}],"cues":[{"id":"line","clip":"voice","animation":"idle","time":0.5}]}
}
```

An optional `producer` block declares the producer handoff: `"producer": {"config": "rig/config.json", "parts": "rig/out", "source": "inputs/painting.png", "full": "inputs/full", "head": "inputs/head"}`. Only `config` is required, `source` may be declared alone, `full` requires `source`, and `head` requires `full`. See *Producer handoff* below. An optional `panels` block (`{"schema": "rig-review/panels@1", "left": ["parts.list"], "stage": ["parts.canvas"], "toolbar": ["parts.layers"], "side": ["parts.issues", "act.submit"]}`) declares the panel composition across the closed slots `left`, `stage`, `toolbar` and `side` (`stage.length === 1` and `side` ending with `"act.submit"`); malformed `panels` blocks refuse with `JOB_PANELS_INVALID` in `parsePanelComposition` and fall back to `panels: undefined` in `parseManifest`.

The illustrative `look` animation in `axes` must also be declared in `animations`. Omit axes when no real angle animation exists. All animation identifiers name actual compiled-model animations; the frontend reports runtime load/lookup errors rather than inventing them. Metadata duration is optional; the player supplies actual duration.

## Files and references

Every path is a literal relative path, including `model`, optional `frames`, `direction`, `scene` and `sets`, optional read-only `motion`, each reference `path`, authoring `path`, clip `path`, and every page name in the compiled model. Manifest paths accept no absolute paths, URL schemes, colon, percent encoding, traversal, backslash, query, fragment, empty segment, or symlink escape. Compiled-model page names are resolved relative to the model directory: a page such as `../parts/page.png` is accepted only when its normalized destination remains inside the review package. This permits portable local builds without letting a page escape the package. All declared files must exist as regular files. The asset endpoint serves only declared files, the manifest, and compiled-model page images. There is no arbitrary directory endpoint. Keep a package focused on the files intended for inspection.

`model` is optional and must point to `rigc-compiled/3` under a filename ending `.model.json`, produced by an upstream gated rigc build. Review uses the public `@rig-c/play` loader and player; Spine JSON/skel is not its input. Its pages are resolved relative to the model document. Missing model means unavailable playback, never a mock playback success. The optional `frames` path declares a producer `rigc-frames/1` record inside the package, read, validated and hashed only when present, added to `files`, and exposed on the loaded package as `frames: {path, sha256, sets: [{animation, fps, written, stride, duration}]} | null` (`null` when omitted, leaving older manifests unchanged); a missing declared file, unreadable JSON, non-`rigc-frames/1` `spec`, malformed set field (`sets[].animation`, `fps`, `written`, `stride`, `duration`) or duplicate animation set refuses by name (`FRAMES_MISSING`, `FRAMES_JSON`, `FRAMES_SPEC`, `FRAMES_FIELD`, `FRAMES_DUPLICATE_ANIMATION`), never falling back silently. With a compiled model, each set must be the producer's schedule for the model animation it names, as measured from `@rig-c/core` 3.8.0 `rigc render`: an animation of duration `D` samples to `round(D * fps) + 1` frames, frame `i` at `i / fps`, and `duration` is the last sample's time, not the clip length (a 0.8 s clip at 12 fps gives 11 frames and `duration` 0.8333). So `written` must equal `floor(round(D * fps) / stride) + 1` and `duration` must lie within `1e-9` s of `round(D * fps) / fps`, or the package refuses by name, naming the animation and both figures (`FRAMES_ANIMATION_UNKNOWN`, `FRAMES_COUNT_MISMATCH`, `FRAMES_DURATION_MISMATCH`); an accepted set is that animation's comment frame clock, `written` frames with frame `i` at `i * stride / fps`, unless the report's clock names the animation ([Stability: frames declaration](STABILITY.md#package-manifest-frames-declaration)). The optional `sets` path declares an attachment-set sidecar for single-package playback. Without that declaration, attachment presets are unavailable. See [Direction inspection](#direction-inspection).

Reference `type` is `image`, `video`, or `pose`. `width` and `height` optionally state image pixel dimensions. The primary animated pose input is the canonical `rig-pose-sequence/1` format documented by `@rig-c/pose`, consumed directly:

```json
{"spec":"rig-pose-sequence/1","space":{"units":"picture-px","origin":"top-left","y":"down"},"width":1080,"height":1920,"source":"producer","frames":[{"t":0,"people":[{"id":"a","joints":{"neck":{"state":"observed","at":[540,410],"score":0.93},"r_wrist":{"state":"missing"}}}]}]}
```

Frame `t` is strictly increasing seconds; local playback uses `t - first.t`. People have stable IDs and sparse named joints. Joint `state` is `observed`, `occluded`, `missing`, or `inferred`; `at` is `[x,y]` and may be off-image; finite scores are preserved without an invented 0…1 ceiling. Missing joints remain missing. An optional top-level `camera` array supplies one `{s,tx,ty,inliers}` entry per frame (`s > 0`, finite translations, integer `inliers >= 0`); `cameraSource` is optional nonempty text only with a camera array. These joint coordinates are already normalized: drawing them on original video would restore `s * at + [tx,ty]`; do not apply that transform twice to the pose panel. The foundation shows a sequence reference and selected person; it does not infer bindings or prove synchronized video retargeting. See the [canonical contract](https://github.com/rig-c/pose#the-pose-rig-pose-sequence1).

A simpler static sketch, used only when explicitly authored in this format, uses:

```json
{"schema":"rig-review-pose/1","coordinateSystem":"image-pixels-y-down","width":800,"height":800,"joints":[{"id":"root","x":400,"y":300},{"id":"tip","x":400,"y":500,"parent":"root"}]}
```

Joints are named source coordinates, not inferred rig bindings. No retargeting, reconstruction, interpolation or quality claim follows from showing them.

## Checkpoints, axes and audio

A checkpoint requires `id` and `title`. Optional `workspace` is `modeling` or `motion`; `animation` names a declared animation; `reference` names a declared reference; `time` is finite seconds >= 0; `note` provides inspection guidance. Optional `camera: {zoom,x,y}` states a positive scale relative to fit and a center in model world coordinates (Y up). Optional `axis: {id,value}` names a declared axis and a finite value inside its min…max range; it is applied after the checkpoint time. The checkpoint URL is `/?checkpoint=<encoded id>`; reopening it restores the declared time and camera, not an approval. The legacy
workspace field remains accepted as checkpoint context; the unified inspection
page has no modeling/motion workspace switch.

An optional axis declares `id`, `label`, `animation`, finite `min` and `max` with `min < max`. It maps the scalar range linearly to that animation's 0…runtime duration for inspection. Only one axis is applied at a time; composite angle blending is not claimed.

Audio clips contain `id`, local `path` and optional `label`. Cues require `id`, a declared `clip`, absolute output `time` in seconds >= 0, and optional declared `animation`. Cues provide audition/synchronization evidence only. This release does not edit source audio, infer phonemes, guarantee sample-accurate playback, or author timeline keys.

## HTTP contract

- `GET /api/review` returns `{manifest, sourceHash, reviewedSource, report, feedbackCatalog, assetsBase:"/assets/", capabilities}`. `report` is the normalized read-only finding data described below, or null. `capabilities` is `{playback:boolean, modeling:false, motion:false, feedback:true, audio:true}`. The modeling/motion flags mean source editing capability; setup and motion inspection share one workspace. `audio:true` denotes the audition facility; clip presence determines what can play.
- `GET /assets/<path>` serves an allowlisted local asset. Encode each path segment when building the URL. Responses use no-store and nosniff headers.
- `GET /api/session` returns the current session or a fresh pending session.
- `PUT /api/session` accepts the full session object below, with matching schema/id/revision/sourceHash. It requires the server's exact Origin, `application/json`, and <= 1 MiB. It returns the saved session with server-generated `updatedAt`.
- The managed workspace routes a single-package session PUT to the target's in-process session handler and preserves its response status and body, including HTTP 400 JSON error responses.

```json
{
  "schema":"rig-review-session/1",
  "id":"rig-name","revision":"2","sourceHash":"<server hash>",
  "reviewedSource":{"packageRevision":"2","viewerVersion":"0.1.0","runtimeVersion":"1.11.0","rig":{"path":"build/skeleton.model.json","sha256":"<exact rig bytes SHA-256>"},"motion":{"path":"motion.json","sha256":"<exact motion bytes SHA-256>"}},
  "status":"pending",
  "checkpoints":{"silhouette":{"outcome":"pending","note":""}},
  "feedback":[{"id":"note-1","frameStart":10,"frameEnd":18,"target":{"kind":"bone","name":"arm"},"category":"defect","summary":"Elbow snaps during the turn","context":{"checkpoint":"silhouette","animation":"idle","interval":{"frameStart":10,"frameEnd":18,"inclusive":true}}}],
  "feedbackWarnings":[],
  "updatedAt":null
}
```

`status` is `pending`, `approved`, or `changes-requested`; checkpoint `outcome` is `pending`, `pass`, or `fail`. Manual feedback requires an inclusive integer interval `0 <= frameStart <= frameEnd` (the strictly validated time-only stage-comment exception is described under Stage region comments), a target `{kind: "bone"|"slot"|"rig", name}`, `category: "defect"|"quality"`, a unique nonempty `id`, and a nonempty one-line `summary` of at most 1000 characters. `context` optionally carries inert inspection JSON (checkpoint, reference/person, time, camera/axis). Frame numbers are explicit user input; there is no guessed FPS. Unknown checkpoint IDs, mismatched content or reviewed-source bindings, duplicate feedback IDs and the old `corrections` authoring-proposal field are refused. Motion is read-only: annotations never author keys, retime output or write `motion.json`. The save does not require all checkpoints to pass: it records the person's explicit decision without manufacturing one.

### Feedback catalog and validation

`feedbackCatalog` is `{rig, bones, slots, animations, clock, clockAnimation}`. `rig` is the exact package id. `bones` and `slots` are actual model names, or null when metadata is unavailable; [] means a known empty list. `animations` is the model's `{name,duration}` list or null. Model names/durations and reviewed model identity are derived from the same exact hashed bytes; the initial page-discovery model bytes must also agree. The catalog does not certify an upstream compile gate.

New feedback requires safe integer frame indices and actual target membership. Unknown names are refused by name, such as `feedback.target.name: slot "no_such_slot" not in model`. Missing model metadata produces a named validation-unavailable refusal for bone/slot feedback. Rig feedback names the exact package id. Scan joints and point expressions are not guessed into model targets.

For a matching report/actual model animation with an explicit bounded clock, `frameEnd` cannot exceed the last declared sample at or before that model clip's end. A clip with no declared sample inside its duration has no valid feedback frames. A different animation cannot borrow the report clock; its frame bound stays unknown unless the declared `frames` record has a set for it, which bounds it the same way. Source-only explicit report clocks remain usable without inventing model animation identity. No duration/frame-count ratio or video FPS supplies a limit; unknown clocks permit manual safe integer intervals.

The server derives `context.interval:{frameStart,frameEnd,inclusive:true}` from the chosen top-level annotation. Contradictory supplied interval data is refused; optional inspection `time` and `frame` remain separate and do not replace it. Compare uses the selected side's catalog and the CLI's exact animation; a row cannot borrow another side's names or bypass the animation binding.

A single-review note also records `context.environment`, the Animate environment it was written under: `{applied, wind:{base, breeze, gust:{peak, duration, repeat, active, value}, total}, gravity, standing:{wind:[x,y], gravity:[x,y]}}`, where `standing` is what the player reported (x right, y down) and `applied:false` means the runtime start values (`wind [1, 0]`, `gravity [0, 1]`). It is `null` when no compiled model was drawn. Records without it (older sessions, compare) stay valid; a present value must have exactly this shape within the control limits. The issue export adds an `Environment:` line for it. The environment is inspection context only: it is never written to the model, the motion or any producer file.

Both session responses include server-derived `feedbackWarnings:[{id,error}]`. Reading an older session preserves invalid target rows and previously accepted integer indices outside JavaScript's safe range, together with source identity, inspection context and original state-file bytes; a missing chosen interval can be derived in memory. Contradictory existing interval evidence remains visible with its warning. The UI shows these warnings and prevents resubmission until the affected rows are corrected or removed. Strict saves independently validate every row and ignore a client's attempt to clear warnings; exports retain the warnings and original feedback evidence. Syntax and source-binding failures remain refusals rather than silently repaired data.

The state filename is a digest of identity, revision, source hash and reviewed artifact/tool identity, so package names cannot select arbitrary filesystem paths. Writes are atomic and source files remain untouched. Review/session load and save stream-hash the declared inputs; changed bytes produce HTTP 409 and require restart. Asset reads do not rehash an entire video: single byte ranges return 206 and invalid ranges 416. Asset documents receive a sandbox CSP with no scripts or same-origin permission, so delivered authoring HTML cannot approve its own package. No network listener beyond loopback or cross-origin mutation is offered.


### Turn inspection context

`context.turn`, when present, is a closed, bounded record:
`{schema:"rig-review-turn/1", values:{yaw?,pitch?,body?}, held:boolean, smoothing:number}`.
Values are the applied dial values, not pending pointer targets. Smoothing is the
normalized-pointer spring frequency (0 disables it, otherwise at most 100 s⁻¹).
Only the model's supported actual sliders supply the permitted axes and ranges;
all offered axes must be present, each finite and within its range. Unknown keys,
missing axes, unsupported models and out-of-range values refuse with `TURN_*`.
A comparison validates against both source-bound models' common axes and range
intersection, irrespective of the feedback's selected side. Model metadata comes
from the same bytes hashed into `reviewedSource`; there is no filesystem parameter
or producer-config discovery in this field. Session source rehashing, identity,
Origin and payload limits still apply. Historical records retain warnings under
the ordinary legacy-read policy; a fresh save cannot bypass this validation.
If a scratch rebuild changes supported axes or expands a range, submission still
uses the original inspected catalog: newly supported values are refused by name
(`TURN_UNAVAILABLE` or `TURN_STATE_MODEL_MISMATCH`), rather than silently certified
as inspected inputs. Authoritative scratch-dial validation is outside this field.
The optional inspection bookmark `selection.turn` has this same shape and is
checked against the active pad before transactional restoration. It restores
applied values, not the pointer's pending travel. No package or motion bytes change.

## Feedback export

The frontend downloads `rig-review-feedback/1` JSON with `id`, `revision`, `sourceHash`, review status, `feedback[]`, and issue-ready `issues[]` entries containing title/body/labels. It also offers Markdown. Each issue contains the frame interval, target, category, summary and package binding. Exports stay local; no issue is posted automatically. These are review annotations, not motion or correction-key artifacts.


## Exact reviewed-source identity and retrieval

`reviewedSource` is server-produced and must return unchanged in submission, draft saves and exports. It contains `packageRevision` (the explicit manifest revision, or `folder-adapter/1`), `viewerVersion` (this app's package version), `runtimeVersion` (the installed `@rig-c/play` package version), and `rig`/`motion`, each null or `{path,sha256}` for the exact reviewed file bytes. No producer version is inferred from a report's generic version field.

The active compiled model supplies rig identity. Without one, a known root or uniquely declared authoring `skeleton.json`/`skeleton.skel` supplies raw evidence identity, still with playback unavailable. Motion identity comes from optional explicit `motion`, an actual root `motion.json`, or a uniquely declared authoring `motion.json`; no missing file receives a guessed hash. These known identity files join the source-hash/asset allowlist. Differently named motion sources require the explicit `motion` path. Each hash is streamed from exact bytes alongside the package hash. Submissions reject altered identity and revalidate current source before saving.

`bun run feedback -- <review.json|output-directory>` reads the existing bound session JSON after the UI closes. With no saved state it emits pending and `updatedAt: null`. It never writes source or creates a review submission. JSON/Markdown exports include this identity, so another agent can tell exactly which rig, motion and viewer revision a person reviewed.


## Producer handoff

An Apply rebuilds through the installed producer from the files the inspected rig was built from: the producer config, its parts directory (`parts.json`, `parts/`) and the inspected rig directory `<parts>/rig/`. Review finds them in this order, first match wins, never by searching:

1. **Declared on the command line**: `rig-review open <dir> --config <path> [--parts <dir>] [--source <png> --full <dir> [--head <dir>]] [--keypoints <file>]`. `feedback` and `control` take the same flags so retrieval binds the same identity. Paths are resolved from the working directory and canonicalized; the worker and every reload read exactly those files.
2. **Declared in review.json**: the `producer` block, package-relative literal portable paths (no `..`, no absolute path, no encoding). Unlike the CLI `--source`/`--full` pair, `producer.source` may be declared without `producer.full`, while `full` still requires `source` and `head` requires `full`.
3. **Discovered inside the opened folder**: `config.json`, then `rig/config.json`.
4. **Discovered beside an opened `out/`**: `../config.json`. It is outside the opened folder, so the record says `"how": "discovered", "outside": true` and the editor bar says *discovered outside the opened folder*, with its path and SHA-256. This step runs only when the opened folder is named `out`, and only for a regular file there (a symlink is refused).

5. **The build's own config, for the `check/` package of a `rig-parts build` output root** (#149): `../config.json` (in the build root), then `../../config.json` (beside it). A `rig-parts build` records no config path or hash, so "the producer's own config for that build" is defined by place, bounded by the build's own files: the opened package root is named `check` and its parent is a build root as recognized above, and the config is the regular file named `config.json` directly in that build root or directly in the folder holding it — the two places `rig-parts build --config <dir>/config.json --out <dir>/out` leaves it. No other parent and no other file name is looked at; a symlink there is refused (`HANDOFF_SYMLINK_ESCAPE`), never followed. The root for this step is the config's folder, the parts directory is the build root, and the record says `"how": "discovered", "outside": true` with the path (`../../config.json`) and SHA-256. Place is not proof that the config built the rig: the session baseline below is that check (`reproduced` or `not-reproduced`, by name). Declaring `--config` at exactly one of those two files (as written, its parent chain canonicalized) is taken the same way with `"how": "declared"`; that file's folder is then the root for `--parts`, `--source`, `--full`, `--head` and `--keypoints`. The build records none of those, so they stay declared-only — except the source painting, which is discovered by one fixed name (below). When nothing is at either place the refusal lists them: `MODELING_INPUT_UNAVAILABLE: config.json — looked at config.json, rig/config.json, ../config.json (in the build root), ../../config.json (beside the build root); declare it with …`.

**Source painting (#329).** A discovered handoff (steps 3–5) takes as its source painting the file named `painting.png` directly beside the config it found — `painting.png` or `rig/painting.png` inside the opened folder, `../painting.png` beside an opened `out/`, and for a build's `check/` package `../painting.png` (in the build root) or `../../painting.png` (beside it) — and nothing else: no other name, no other folder, no search (a painting in `inputs/` is declared with `--source`). It is held to the config's own rules at that place: it must stay inside the same root, must be a regular file (`HANDOFF_INPUT_INVALID`), and at the places outside the opened folder (steps 4 and 5) any symlink is refused (`HANDOFF_SYMLINK_ESCAPE`), never followed; inside the opened folder a symlink that leaves the root is refused the same way. The field names the place (`../../painting.png`). When present it is the record's `source`, exactly as a declared `--source` is, and is the handoff source the Bones check's `propose --from-config` reads; it declares no `--full`, so a `build` Apply still refuses for the See-through runs. Absent, the record's `source` stays `null` and nothing else changes.

Without `--parts` the parts directory is `out/` beside the config (for step 4, the opened `out/` itself; for step 5, the build root). A declared or discovered path that is missing, outside its root (the package root; for step 4 the folder holding `out/`; for step 5 the config's folder), or a symlink that leaves it is refused by name: `HANDOFF_PATH_OUTSIDE_ROOT`, `HANDOFF_SYMLINK_ESCAPE`, `HANDOFF_INPUT_MISSING`, `HANDOFF_INPUT_INVALID`, `HANDOFF_PATH_INVALID` (`open` prefixes `OPEN_HANDOFF_INVALID <flag or path>`). `rig-review open` verifies at start (before spawning or reusing a worker) that every inspected package has a compiled `model` that `@rig-c/play` loads and decodes, and in single mode by default also requires a complete producer handoff (`handoffGap`, `producerInputs`, `resolveProducer`, `contourParts`), exiting non-zero with `OPEN_MODEL_UNAVAILABLE: <reason>` when the model or handoff is missing or broken. Passing `--view-only` explicitly permits opening a compiled model that has no producer handoff at all (`handoff === null`), in which case `/api/rebuild` reports the neutral status `"view only, no producer handoff"` (with `viewOnly: true`) and no panel renders a `MODELING_*` error string; a declared or partially-present handoff with a gap still refuses `OPEN_MODEL_UNAVAILABLE: <reason>` even with `--view-only`. When `startServer` runs directly without `--view-only` and no handoff is found, `/api/rebuild` reports `MODELING_INPUT_UNAVAILABLE: config.json — looked at config.json, rig/config.json, ../config.json (beside an opened out/); declare it with rig-review open <dir> --config <path> [--parts <dir>] or the review.json "producer" block`, and Apply refuses `MODELING_HANDOFF_MISSING`.

**Hashed files.** The config; the references the installed `@rig-c/parts` `configFileReferences` export declares against the config's directory (`requirements`, `motion.animations_from`, `generation.control.skeleton`, `assemble.occluders[i].image` as regular files, and `assemble.occluders[i].plate` as a directory input bound by `<directory>/receipt.json`'s raw SHA-256 with `{path:"<directory>/receipt.json", sha256, directory:"<directory>", spec}` matching `@rig-c/parts` `PLATE_RECEIPT_SPEC` and `create#326` `93b361f8bfec0ec7e20318d9c8e643eef5d7a674`, never by hashing plate sibling files; each must stay inside the root, a missing one is listed in `missing`, and an unknown reference or an older installed loader that omits a declared occluder input is refused by name with `HANDOFF_INPUT_INVALID`); `parts.json` and every regular file directly in `parts/`; every regular file directly in the inspected `rig/` (`rig.json`, `motion.json`, `mesh_report.json`, `sets.json`, …) and `rig/images/`; with `--source`/`--full`/`--head`, that PNG and the regular files directly in those directories; for a discovered handoff, the `painting.png` beside its config when there is one; with `--keypoints` (#111; the review.json block's `keypoints`), that file — the same path rules as `--source` (literal, inside the root, no symlink escape).

**Record and identity.** `reviewedSource.handoff` (absent when there is no handoff, so earlier identities are unchanged):

```json
{"schema":"rig-review-handoff/1","how":"discovered","via":"discovery","outside":false,
 "config":{"path":"rig/config.json","sha256":"…"},"parts":"rig/out","rig":"rig/out/rig","source":null,"full":null,"head":null,
 "files":[{"path":"rig/config.json","sha256":"…"},{"path":"rig/out/parts.json","sha256":"…"}],"missing":[]}
```

`keypoints` (#111) is `{path, sha256}` and is present only when the keypoint file is declared: a handoff without it has no `keypoints` key and hashes no keypoint file, so its record and identity are what they were before. `how` is `declared` or `discovered`, `via` is `open --config`, `review.json producer` or `discovery`, and paths are relative to the package root (`../` only for steps 4 and 5). The record is part of `reviewedSource`, so it reaches `/api/review`, the session, the feedback export and the session file name: changing any handoff file's bytes starts a new pending session while `sourceHash` (the package bytes) is unchanged, and the open-managed key changes with it. The same inputs give the same record, key and URL.

**Baseline.** See README, *Chest regions*: once per session `rig-parts rig --config --parts --out <state>/baseline/<key>/baseline`, compared file by file with the inspected rig; `/api/rebuild` returns `baseline` (`status` `running`, `reproduced`, `not-reproduced`, `refused` or `failed`, `firstDifference`, both rig.json and tree hashes, `wallMs`, and since #148 `reach` when not reproduced — *Baseline reach*, below). Nothing is written into the package. Once the baseline reproduces, `rig-parts check --rig baseline --out inspected-check --parts <parts> --page-edges free --pack-shape polygon` runs in the background in the same directory, and `/api/rebuild` returns `inspectedCheck` (`{schema:"rig-review-inspected-check/1", key, status:"running"|"checked"|"refused"|"failed", lines[], check (the check summary, or null), line ("check running…", check's `check: …` line, or its named refusal verbatim), exitCode, wallMs}`, else `null`). The finished record is stored as `<state>/baseline/<key>/inspected-check.json`, so a reopen reads it instead of re-running; it is the physics readout's BEFORE for the inspected build.

## Config patch and Apply (`rig-review-config-patch/1`)

Every edit card states its edit as one config patch; review applies it to a scratch copy of the handoff config and rebuilds through the installed producer. The package's config, parts and rig are only read.

```json
{"schema":"rig-review-config-patch/1",
 "config_sha256":"<SHA-256 of the handoff config bytes the patch was made against>",
 "ops":[{"op":"replace","path":"/constraints/0/damping","value":0.8}],
 "producer":{"name":"@rig-c/parts","version":"1.42.0"},
 "op":{"cmd":"rig","args":[]}}
```

- **Document.** Exactly these five keys. `ops` holds 1–256 operations, each `replace` or `add` (`{op, path, value}`, value any JSON) or `remove` (`{op, path}`), each with an optional `name` (#103): the `name` the list entry `/<list>/<index>` holds in the config the patch was made against (a physics edit records `{"op":"replace","path":"/constraints/1/damping","value":0.3,"name":"fringe_r1_physics"}`), applied in order with RFC 6902 semantics; `path` is an RFC 6901 JSON Pointer into the config (`~1` is `/`, `~0` is `~`; an array index is a decimal without leading zeros, and `add` may use `-` to append). `""` (the whole config) is refused. `producer` is the producer the patch was made for. `op.cmd` is `rig` (rebuild the whole rig from the patched config) or `remesh` (re-fit one part from its patched `meshes.<part>` entry; `args` must hold `--part <name>`). `op.args` may also hold `--idle-keys ctl|direct`, `--page-edges pot|free` and `--pack-shape rect|polygon`, each once; nothing else, never a path.
- **Refusals before anything runs.** Malformed (HTTP 400): `EDIT_PATCH_INVALID`, `EDIT_PATCH_OP_UNKNOWN`, `EDIT_PATCH_POINTER_INVALID`, `EDIT_PATCH_CMD_UNKNOWN`, `EDIT_PATCH_ARG_UNKNOWN`. Outcomes (HTTP 200, `{status:"refused", error, producerLine:null}`): `EDIT_PATCH_STALE` when `config_sha256` is not the handoff config's hash; `EDIT_PATCH_PATH_MISSING` when a pointer does not resolve in that config; `EDIT_PATCH_NAME_MISMATCH` when an op's `name` is not the name its index holds there; `EDIT_PATCH_PATH_HELD` when the patch changes a reference the config resolves against its directory (`requirements`, `motion.animations_from`, `generation.control.skeleton`, `assemble.occluders[i].image`, `assemble.occluders[i].plate` — handoff inputs); `EDIT_PATCH_OUT_OF_SCOPE` when a `remesh` patch edits outside `/meshes/<part>`; `EDIT_PRODUCER_MISMATCH` when the installed producer is not the patch's; for a `rig` patch the runner runs as the whole-rig `rig` (*Routing*, below), `EDIT_BASELINE_MISMATCH: <first differing path>` unless the session's baseline reproduced the inspected rig (*Producer handoff*, Baseline); and the producer-resolution refusals of an Apply.
- **Routing (#136).** A `rig` patch runs `rig-parts retune` instead of the whole-rig `rig` when the installed producer is `@rig-c/parts` 1.44.0 or later (`RETUNE_SINCE`, the CHANGELOG's first release with retune) and **every** op's pointer lies at or under one of `/constraints`, `/motion/duration`, `/motion/tracks`, `/motion/blink/t`, `/motion/blink/squash`, `/motion/blink/brow_drop` (`src/retune-route.ts`). The scope is retune's own help: it splices the config's constraints (rig.json `constraints` and `invariants.detached`) and idle (motion.json `animations.idle`) onto the gated inspected rig and holds stops, bones, slots, skeleton, images, every other invariant and every other byte of motion.json (`RETUNE_REQUEST_HELD`). So `/stops`, `/bones`, `/regions`, `/turn`, `/meshes`, `/motion/animations_from`, the blink's `eyes` and `brows` (its motion.json groups) and `still` (a `<part>_still` slot), and a patch mixing any of them with retune's pointers, keep the whole-rig `rig` behind the baseline guard; so does every patch on an older producer. Retune needs no baseline, but it does not carry every repair (#148, `@rig-c/parts` 1.49.1 AUTHORING §retune and `src/retune.ts`): it carries every attachment and every `mesh_report.json` row over as bytes, so a **mesh** repair the config does not reproduce stays; it holds every image file (with stops, bones, slots, skeleton, every invariant but `detached` and motion.json outside the idle) to the config's rebuild, so on a build whose repair redrew an image every retune refuses `RETUNE_REQUEST_HELD: images/<part>.png — the config changes it`; and it splices `rig.json` and `motion.json` as text, so an input that is not the writer's text refuses `RETUNE_INPUT_WRITTEN`. Measured on parts-examples `family/roa` (a hand shoulder repair that redrew `topwear.png`, parts 1.49.1): as committed, retune refuses `RETUNE_INPUT_WRITTEN` (its `rig.json` is not the writer's text); re-serialised in the writer's format, it refuses `RETUNE_REQUEST_HELD: images/topwear.png`. The baseline line says which applies (*Baseline reach*, below). What it judges per value (a track that newly keys a mesh-bound bone, which gains a `<bone>_ctl` under `--idle-keys ctl`) comes back as its own `RETUNE_REQUEST_HELD` line verbatim, as do `RETUNE_CONFIG_REFUSED` and its other refusals.
- **Baseline reach (#148).** When the baseline does not reproduce, `baseline.reach` (`src/baseline-reach.ts`) reads both rig directories and states what each producer op will still take, from the producer's own holds: `{schema:"rig-review-baseline-reach/1", notWriterText[], images[], retuneHeld, remeshRefused[], meshParts[], bonesDiffer, ops:{retune, delta, version}, text}`. `notWriterText`: the inspected `rig.json`, `motion.json` and `mesh_report.json` that are not `JSON.stringify(value, null, 1)` and a closing newline (the writer, parts `rigJsonText`) — remesh and its mesh edit refuse `rig.json` / `mesh_report.json` (`REMESH_INPUT_WRITTEN`), retune `rig.json` / `motion.json` (`RETUNE_INPUT_WRITTEN`). `images`: the images the config draws differently. `retuneHeld`: retune's first held difference in its own order (stops, bones, slots, skeleton, images, invariants but `detached`, each image, motion.json outside `animations.idle`), or null when a physics or idle edit Applies. `remeshRefused`: the meshed parts (`skins.default.<part>.<part>` of type `mesh`) whose attachment, image or report row (or an `auto` row's motion) the config does not reproduce — remesh from a config entry refuses them `REMESH_BASELINE_MISMATCH` and re-fits the rest; `bonesDiffer` refuses every part. A mesh edit (`remesh --delta`) builds no config entry, so the baseline does not hold it. `ops` is the installed producer's: below 1.44.0 a physics or idle edit is whole-rig. `text` is appended to the baseline line (`baseline: not reproduced — <first differing path> · <text>`) and to `EDIT_BASELINE_MISMATCH: <path> — <text>`. It is review's reading of the producer's rules; the producer's line on Apply stays the judgment. For family/roa as committed: `out/rig/rig.json, out/rig/mesh_report.json are not the text rig writes for their values (reformatted, or written by another tool), and an op that splices a revision as text refuses such a file — use the files as rig wrote them, or re-serialise them in a copy of the package exactly as rig writes them (JSON with one space of indent and a closing newline) and open the copy; whole-rig edits refuse (EDIT_BASELINE_MISMATCH); physics and idle edits (retune) refuse out/rig/rig.json (RETUNE_INPUT_WRITTEN), and past that the config draws out/rig/images/topwear.png differently and retune holds every image (RETUNE_REQUEST_HELD); remesh and a mesh edit refuse out/rig/rig.json, out/rig/mesh_report.json (REMESH_INPUT_WRITTEN); past that, remesh: bottomwear, topwear, hair_back, hair_front are refused (REMESH_BASELINE_MISMATCH: …); handwear_r, neck, earring can be re-fit`.
- **Producer refusal hint (#148).** When the producer refuses with a line review can explain — `REMESH_INPUT_WRITTEN` / `RETUNE_INPUT_WRITTEN` (a file that is not the writer's text) or `RETUNE_REQUEST_HELD: images/<name>` (an image the config draws differently) — the job keeps `producerLine` as printed and adds `hint` (absent otherwise), also pushed to `lines` as `review: <hint>`; the status line reads `<producer line> · review: <hint>`. For `RETUNE_INPUT_WRITTEN` on `rig.json`: `rig.json in the inspected rig is not the text rig writes for its value (reformatted, or written by another tool); retune splices a revision as text, so it refuses the file — use the files as rig wrote them, or re-serialise them in a copy of the package exactly as rig writes them (JSON with one space of indent and a closing newline) and open the copy`.
- **Build (#115).** A `rig` patch with any op at or under `/assemble` or `/limbs` — or under `/bones` on a config that declares `limbs`, whose joints are their bones' origins — runs `rig-parts build` (op `build`): those sections are read by the producer's assemble stage, which `rig --config --parts` never runs (rig-parts AUTHORING §3, the `assemble.cuts`, `assemble.patches` and `limbs` rows). It needs the handoff's painting and full run (`--source <png> --full <dir> [--head <dir>]`, or the review.json block); without them it refuses before anything runs: `MODELING_INPUT_UNAVAILABLE: source painting and See-through runs — rig-parts build reassembles the parts from the painting (--source) and the runs (--full, --head) before the rig, and the handoff declares none; declare them with …`. It is a whole-rig op behind the reproduced baseline (`EDIT_BASELINE_MISMATCH`). The files assemble reads by the config's own naming (each cut's `under`, each limb segment's `cap`, each alternate's `source`, `full`, `head` and `skeleton`) are resolved against the handoff config's directory, must stay inside the package root (`BUILD_INPUT_OUTSIDE_ROOT`, `BUILD_INPUT_MISSING`) and are hashed into the build id — a named directory outside the declared runs by its contents (every regular file under it, at most 8 levels deep and 4096 files, each held inside the package root, in path order; over the bound refuses `BUILD_INPUT_TOO_LARGE`), a declared run through the handoff record (#185); a patch may not name a new one (`EDIT_PATCH_PATH_HELD` — it may keep, move or drop one the config names). `config.json` is the patched config with those paths and the two above made absolute, then `rig-parts build --config config.json --source <handoff source> --full <handoff full> [--head <handoff head>] --out out --seam-pairs [args]`; the rig spec is `out/rig`, and the shared tail diffs and compiles it (no second check: build's own check ran on the parts it assembled). A stage that refuses leaves no scratch, and its FAIL lines come back verbatim (the stage prefix `[assemble]`, `[rig]`, `[check]` stripped); a build that stopped at check with bars not met is kept, check's FAIL lines beside it. The job adds `assembled: {inputs:{source, full, head, named:[{field, path, sha256|null}]}, refusals[], checkFails[], lines[] (the cut:, limb cut:, limb cap: and uncovered-hole lines), seam[], seamPairs[] (the base set's `seam pair` lines), recomposite:{line, before, after, errorMap:{url, sha256}|null}, parts:{changed[], unchanged, partsJson:{count, paths}}|null}` (`before` is the handoff's `parts.json` recomposite block, `after` the scratch one; `errorMap` serves `out/recomposite_error_rig.png` read-only at `/rebuild/<id>/recomposite/recomposite_error_rig.png`), and `wallMs.op` is the build's own wall clock (assemble → rig → check).
- **Cloth (#111).** A `rig` patch whose ops all lie under `/cloth` (the Setup · Cloth block: one recipe per tag the installed reader accepts — resolved from its `package.json` `exports["./cloth-targets.json"]`, schema `rig-parts/cloth-targets@1`, since `@rig-c/parts` 2.51.0, refused as `CLOTH_TARGETS_INVALID` when malformed or outside the package; when that export key is absent on an older producer, it falls back to the tags the config already declares with `read: false` and refuses adding a new tag as `CLOTH_TARGETS_UNAVAILABLE: the installed rig-parts <version> has no cloth-targets export (needs 2.51.0)` — with the reader's fields) runs op `cloth`; a patch mixing `/cloth` ops with others is refused before anything runs (`CLOTH_PATCH_MIXED`). Refused before anything runs: `CLOTH_KEYPOINTS_UNDECLARED` when the handoff declares no `--keypoints` (without them the draft moves the body bones the config states — Decision 1), `MODELING_PRODUCER_TOO_OLD <found> 1.49.1` (the first `@rig-c/parts` whose `--write-config` splices `bones`, `constraints` and `motion.tracks` entry by entry, parts#552), `MODELING_INPUT_UNAVAILABLE: source painting …` without `--source`, and, as a whole-rig op, `EDIT_BASELINE_MISMATCH`. `cloth.json` is the patched config written as `rig` writes its scratch config, with the assemble-read paths made absolute as for `build`; then `rig-parts propose --parts <handoff parts> --source <handoff source> --keypoints <handoff keypoints> --out propose --cloth cloth.json --write-config config.json` (no `--wrist-snap` or `--grid-rule`: the handoff states neither). Its refusals come back verbatim, every FAIL line in `cloth.refusals` — the reader's `CONFIG_CLOTH_*`, `PROPOSE_CLOTH_DRAFTED` (a recipe that drafts nothing), `PROPOSE_CLOTH_PART`, and the write's `PROPOSE_WRITE_CONFIG_FRESH`, `PROPOSE_WRITE_CONFIG_CONFLICT` (an entry the recipe re-drafts or removes that equals neither the draft with the recipe nor the draft without it, rig-parts AUTHORING *The config written*) and `PROPOSE_WRITE_CONFIG_SPLICE`. Review reads only the written `config.json`, never the producer's draft file: it lists every JSON Pointer at which the written config differs from `cloth.json` and refuses to build one that differs outside the sections propose splices (`bones`, `constraints`, `meshes`, `regions`, `limbs`, `motion/tracks`, `turn`, `proposed_rig_scale`): `CLOTH_WRITTEN_OUTSIDE_DRAFTED`. The written config is then built (Decision 2) as `rig-parts build --config config.json …` exactly as a `build` patch when the config declares `limbs` (the job adds `assembled`), else `rig-parts rig --config config.json --parts <handoff parts> --out rig`, and goes through the shared tail. The id adds `cloth`, the keypoint file's hash and (for the build route) the build inputs' hash. The job adds `cloth: {route:"build"|"rig", inputs:{source, keypoints:{path, sha256}}, refusals[], line (propose's `wrote config.json: …` line), written:{count, paths[≤200], outside[≤200], sections[]}|null, links[] (per tag: its parts and the written config's chains, the link preview), wallMs:{propose, build}}`. `GET /api/rebuild` adds `cloth: {targets, targetsRead, targetsReason, recipes, tags[] (per tag: its parts by See-through tag or by the recipe's `part`/`parts`, and the chains their `meshes.<part>.segments` name with `points` and `tip`), keypoints, route, reason}`.
- **Run.** Scratch is `<state>/rebuild/<package source hash>/<id>/`, `id = sha256([rig-review-rebuild/1, "patch", source hash, config SHA-256, the patch's canonical bytes, producer@version, compiler@version])` — no clock; the same patch again reuses its build. `rig`: `config.json` there is the patched config written as the producer's own scratch configs are (2-space JSON, every `configFileReferences` path made absolute when it names an existing entry beside the handoff config), then `rig-parts rig --config config.json --parts <handoff parts> --out rig [args]`, or for a retune-routed patch `rig-parts retune --rig <handoff rig> --config config.json --parts <handoff parts> --out rig [args]` (the same config; retune reads the inspected rig and writes only `rig/`, with `retune.json`). `remesh`: `mesh.json` is the patched `meshes.<part>` entry and `rig-parts remesh --rig <handoff rig> --config <handoff config> --parts <handoff parts> --part <part> --mesh mesh.json --out rig [args]` (remesh reads the config as written). Then `rigc build --rig rig/rig.json --motion rig/motion.json --out build --profile rig-play --pack --page-edges … --pack-shape …` (the args' values, else `free` / `polygon`; for remesh, its `remesh.json` request; for retune, its `retune.json` request) and `rig-parts check --rig rig --out check --parts <handoff parts>` with the same pack flags. A producer or compiler refusal is the first named line verbatim and leaves no scratch; a check `FAIL` is check's judgment, kept beside the build.
- **A retune's check (#139).** A retune-routed Apply does not run `rig-parts check` a second time: retune already gated and checked the revision it wrote (`checkStage` over that revision, the same `--parts` and pack flags review passes), and from `@rig-c/parts` 1.49.0 (`RETUNE_CHECK_SINCE`, parts#541) `retune.json`'s `check.revision` carries `line` — check's own last line, byte for byte — and `status` — every block's status as that tree's `check.json` records it, in the file's order. Review first binds it to the files: every `revision` hash row's file under `rig/` must hash to its row, none missing, and `rig/` holds no file but those rows and `retune.json`; otherwise the Apply is refused `RETUNE_CHECK_STALE: <file> sha256 <in retune.json> … <on disk>; retune's check is not this revision's, so no build is recorded` (`absent` on the side without the file) and leaves no scratch. Bound, the side becomes the same check summary a separate check gives (below): `pass` ← `pass`; `exitCode` ← 0 when it passes, else 1 (check's own exit); `line` ← `line`; `bars` ← every upper-case `status` entry (`gate`, `loop` and `seam` are read off figures and are not check.json bars); `gate` ← `status.gate` is `PASS`; plus `source:"retune"`. The job's `wallMs.check` is `null` and its lines say `review: check not run again — retune.json carries retune's check of this revision, bound to it by N revision hash row(s): <line>`. Check still runs on the revision, as before, when `retune.json` carries no `line` / `status` (an older producer; the line says so — not a refusal) or when the Apply checks under an exported world (#112; retune's check read the default one). Whole-rig `rig`, `build` and cloth keep running check.
- **A remesh's check (#174).** A `remesh` patch Apply (#106) reads `rig-parts remesh`'s own check of its revision the same way, with one binding shared with retune: `remesh.json`'s `check.revision` (`line` and `status` since `@rig-c/parts` 1.49.0, `REMESH_CHECK_SINCE`; the same parts#541 change) is bound by its `revision` hash rows to the files under `rig/` (none missing, none but those rows and `remesh.json`), else the Apply is refused `REMESH_CHECK_STALE: <file> sha256 <in remesh.json> … <on disk>; remesh's check is not this revision's, so no build is recorded` and leaves no scratch. remesh checked the revision with its request's `page_edges` / `pack_shape` — the flags review's own check reads from `remesh.json` — and the handoff `--parts`; a patch passes no `--requirements`. Bound, the summary is the same mapping as retune's with `source:"remesh"`; `wallMs.check` is `null` and the line says `review: check not run again — remesh.json carries remesh's check of this revision, bound to it by N revision hash row(s): <line>`. An older `remesh.json` or an Apply under an exported world runs check, and the line says why. The designation remesh (#99) and Edit Mesh's `remesh --delta` (#135) run no review check at all (remesh's own gate holds check there), so they are unchanged.
- **Request and job.** `POST /api/rebuild` takes exactly `{patch}` (or #99's `{part, regions, configHash}`, or #105's `{part, bust, configHash}` — see *Chest landmarks* below, or #135's `{part, delta, configHash}` — see *Mesh edit export*), same-origin, 64 KiB. The job (`GET /api/rebuild/<id>`): `{schema:"rig-review-rebuild/1", kind:"patch", id, status:"running"|"built"|"refused"|"failed", reused, request:{patch, patchSha256, configHash}, producer, compiler, lines[], producerLine, exitCode, wallMs:{op, compile, check}, check, diff:{count, paths[≤200]}, build:{model, modelUrl, modelHash, files}|null}`. `diff` lists every JSON Pointer at which the scratch `rig.json` differs from the inspected one (a changed leaf or type, a key or index only one side has). `check` is `{schema:"rig-review-check-summary/1", pass (check.json's PASS, or null without one), exitCode, line (check's last `check: …` line, or its first named refusal), bars:{NAME: status}, gate}`, plus `source:"retune"` or `source:"remesh"` when the summary is that op's carried check (#139, #174; absent: check's own output, `check.json` and its stdout).

**`context.applied`.** Feedback written while a scratch build is on the stage carries the applied state; otherwise `null`. Absent and `null` stay valid, and a present value must be exactly one of:

- `rig-review-applied/1` (#99 regions): `{schema, buildId, part, regions, configHash, entrySha256, producer, compiler, line, modelHash}`; a Landmarks Apply (#105) adds `bust` (the `contour.bust` entry as sent) and its `regions` are review's derivation of the two circles.
- `rig-review-applied/2` (patch): `{schema, buildId, patch, patchSha256, configHash, producer:{package,version}, compiler:{package,version}, line, check, diff, modelHash}` — the exact patch (whose `config_sha256` equals `configHash`), its hash, the producer's last line, check's summary and the rig.json diff. Since #136 the record adds `op`, the producer op that ran: `"rig"` or `"retune"` for a `rig` patch, `"remesh"` for a remesh patch (anything else is refused); the job carries the same `op` and its lines name the command. Records without `op` stay valid. Since #111 `op` may be `"cloth"` for a `rig` patch whose ops all lie under `/cloth`, and exactly then the record adds `cloth: {route:"build"|"rig", keypoints:{path, sha256}, written:{count, paths[≤200]}}` — how the config propose wrote was built, the keypoint file it read and where the written config differs from the patched one — and, when the route is `build`, `assembled` as below; the export's `Applied:` line names the written diff and the route. Since #115 `op` may be `"build"` for a `rig` patch, and exactly then the record adds `assembled: {wallMs, recomposite:{before, after}, partsChanged[], seamPairs[≤64]}` — the build's wall clock for that Apply, the recomposite figures, the parts whose PNG changed against the handoff's and the `seam pair` lines; the issue export's `Applied:` line names the wall clock (`· build 118.0 s · parts changed: bottomwear, ribbon_r · recomposite error px 8194 → 8194`). A remesh patch from the Mesh panel (#106) adds `mesh: {part, before:{vertices, triangles, hull}, after:{vertices, triangles, hull}}` — the revision's `remesh.json` counts; `part` must be the part the patch's `remesh --part` names. Since #125 the record adds `files: {documents:[{file, count, paths}], images:{changed, unchanged, names}}` (or `null`) — the scratch rig against the inspected rig, every document the producer writes: `documents` in the order `rig.json`, `motion.json`, `sets.json`, `mesh_report.json` (each `file` at most once; a document neither side has is left out), `count` the number of RFC 6901 pointers at which it differs and `paths` the first ≤ 200 of them (`""` — the whole document — when only one side has it or a side is not JSON, unless the bytes are equal); `images` compares `images/*` by SHA-256 only: `changed` (including an image only one side has, its `images/<name>` in `names`, ≤ 200) and `unchanged`. `diff` stays rig.json's entry as before. Records without `files` (written before #125) stay valid. The list of documents is `PRODUCER_DOCUMENTS` in `src/producer-files.ts`, the same list the baseline compares. The Apply status line and the export state it per file: `motion.json differs at 2 path(s) · rig.json, sets.json, mesh_report.json unchanged · 31 images unchanged`.
- `rig-review-applied/3` (#135, Edit Mesh's delta): `{schema, buildId, part, delta, deltaSha256, configHash, producer, compiler, line, op, files, mesh?, modelHash}` — the `rig-review-mesh-edit/1` document as sent (basis `"setup"`, `slot` the part, at most 300 ops), the SHA-256 of its bytes, the producer's last line, `op` always `"remesh"`, the per-file diff as above (or `null`) and the part's `remesh.json` counts (`mesh.part` must be `part`). No `check`: `rig-parts remesh` holds check on the revision itself (`REMESH_CHECK_HELD`). See *Mesh edit export*.

**Readings (#108).** `POST /api/readings` (single review; same-origin, capability, 64 KiB) takes exactly `{animation, readings:[1–8], environment}`: each reading is `{kind:"folds"}`, `{kind:"overlaps"}`, `{kind:"pass-through", cloth, leg}`, `{kind:"seam", a, b}` or `{kind:"angle-range", bone, relative}`, every name a slot or bone name without `:` or `,` (whether the rig has it is rigc's to say), no reading twice; `environment` is `null`, `{wind:[x,y], gravity:[x,y]}` (x right, y down) or, with *Use for readings* on (#112), the exported `rigc-environment/1` schedule as data. Malformed: HTTP 400 `READINGS_REQUEST_INVALID`. Outcomes (HTTP 200 `{status:"refused", error}`): `READINGS_COMPILER_NOT_INSTALLED` (`@rig-c/core` first, legacy `rig-c` only when absent, beside `@rig-c/parts`, else beside the package or review), `READINGS_COMPILER_TOO_OLD <found> 2.63.0`, `READINGS_NO_MODEL`, `READINGS_STATE_INSIDE_PACKAGE`, `READINGS_BUSY`. The job (`GET /api/readings/<id>`, the id hashed from the package, the request, the inspected model's bytes, the scratch build id, the compiler and whether the schedule was passed): `{schema:"rig-review-readings/1", id, status:"running"|"done"|"failed", error, request, environment:{requested, flag, passed}, compiler, runs:[{build:"inspected"|"scratch", id, modelHash, results[]}]}`. Each result is `{reading, label, status:"read"|"refused"|"failed", fps, frames[] (every frame the reading's JSON lists: folds' meshes' frames, pass-through's frames, seam's opens, overlaps' moving pairs' runs; angle-range's lowest and highest frame from its printed line), source:"json"|"line", worst:{frame, figure, line}|null, items[] (per mesh or pair), lines[] (rigc's printed rows for the reading), refusal (rigc's `rigc: …` line verbatim), exitCode, wallMs}`. The inspected build is `--candidate <the directory of the manifest's model>`; the scratch build is the session's latest built Apply. Each reading runs as `rigc render --candidate <build> --animation <animation> [--environment environment.json] <flag> --out render` in `<state>/readings/<package hash>/<inspected-<model sha256>|scratch-<build id>>/<key>/`, keeps `result.json`, the reading's JSON and `frames.json`, and removes the rendered frames. The schedule `{spec:"rigc-environment/1", steps:[{t:0, wind, gravity}]}` is passed only when `rigc render --help` lists `--environment`. A schedule sent in the request is written as sent (re-serialized, one-space JSON and a newline).

**Environment schedule (#112).** The Animate Environment block exports its controls as a `rigc-environment/1` schedule (`src/environment-schedule.ts`): `{spec:"rigc-environment/1", steps:[{t, wind?:[x,y], gravity?:[x,y]}]}`, x right, y down, t = 0 at the clip's first frame, written as one-space JSON and a newline (the bytes downloaded, sent and hashed). With neither breeze nor a repeating gust it is the step form, one step `{t:0, wind:[base,0], gravity:[0,g]}` (#108's standing schedule) — exact. With breeze or repeat on it is the sampled form: one step per frame at 12 fps (rigc render's default and check's IDLE_FPS) from 0 to the clip's last frame (`round(duration·12)`; rigc refuses a step after it), each the panel's wind at that time from a fresh clock (a repeating gust starts at 0, every `max(6, duration + 0.6)` s, turned when the base is negative), a step equal to the one before left out, gravity on the first step. rigc sets a step before the physics step that ends on its frame, as the page sets the wind before the player's step, so the schedule equals the panel's wind at every frame time; between frames rigc holds the frame's value, within `max|dw/dt| / 12` of the panel's (`(breeze ? 8.48 : 0) + (repeat ? peak·π/duration : 0)`, over 12). A one-off Gust (Repeat off) is not in the schedule. Refused by name: `ENVIRONMENT_NOT_APPLIED` (the controls are not engaged; check and render without `--environment` already read the runtime's world), `ENVIRONMENT_SCHEDULE_NO_CLIP`, `ENVIRONMENT_SCHEDULE_TOO_LONG` (more than 600 steps). *Use for readings* sends the drawn clip's schedule with readings and the checked clip's (`idle` when the rig has one) with Apply, and restarts the wind clock with the clip (and at each idle loop) so the person watches the world rigc reads. *Export schedule* downloads `rigc-environment.json`.

**Check under this world (#112).** `POST /api/environment-check` (single review; same-origin, capability, 64 KiB) takes exactly `{build:"inspected"|"scratch", schedule}`, the schedule as data (exact keys, ascending t from 0, a half stated per step, at most 600 steps); malformed: HTTP 400 `ENVIRONMENT_CHECK_REQUEST_INVALID`. Outcomes (HTTP 200 `{status:"refused", error}`): `MODELING_HANDOFF_MISSING`, `ENVIRONMENT_CHECK_NO_SCRATCH`, `MODELING_PRODUCER_NOT_INSTALLED`, `MODELING_PRODUCER_TOO_OLD <found> 1.48.0: rig-parts check --environment needs @rig-c/parts 1.48.0 or later — …`, `ENVIRONMENT_CHECK_STATE_INSIDE_PACKAGE`, `ENVIRONMENT_CHECK_BUSY`. Review writes the schedule as `environment.json` in `<state>/environment-check/<package hash>/<id>/` (the id hashes the package, the schedule's bytes, the build, the scratch build id, the handoff config and the producer; no clock) and runs `rig-parts check --rig <the handoff rig, or the latest scratch build's rig spec> --out out --parts <handoff parts> --page-edges free --pack-shape polygon --environment environment.json` there — the inspected build's own background check's flags, so the default-world line beside it differs only by the world. The check output is removed; `result.json` is kept, and the same schedule on the same build is read back. The job (`GET /api/environment-check/<id>`): `{schema:"rig-review-environment-check/1", id, status:"running"|"checked"|"refused"|"failed", build, buildId, schedule:{sha256, size, steps}, producer, exitCode, wallMs, check (the check summary), environment (check.json's `{path, sha256, steps}`; a sha256 that is not the schedule's fails the job, `ENVIRONMENT_CHECK_UNRECORDED`), environmentLine (check's `environment: …` line), bars:[{name, line}] (ANIMATIONS_DO_NOT_FOLD and TEXTURE_STRETCH as check printed them), error (a `FAIL  CHECK_ENVIRONMENT: …` refusal verbatim), lines[]}`. A bar that check judges FAIL is check's judgment (`status:"checked"`), not a refusal.

**Apply under the world (#112).** `POST /api/rebuild` also takes `{patch, environment}`: the schedule check reads in the shared tail (`--environment environment.json`, written into the scratch directory first; a `build`-routed patch forwards it to `rig-parts build`, whose check stage reads it). It needs `@rig-c/parts` 1.48.0 (`MODELING_PRODUCER_TOO_OLD <found> 1.48.0: rig-parts check --environment …`, nothing run); a malformed schedule is HTTP 400 `REBUILD_REQUEST_INVALID`. The patch id adds the schedule's sha256, so a default-world build is never reused for it. The job and `rig-review-applied/2` add `environment:{sha256, steps}`; without a schedule neither carries the key and nothing in the tail moves.

**`context.readings`.** Feedback written after a readings run carries the pairs of the last finished run: `{schema:"rig-review-readings/1", animation, requests[] (the readings as sent), environment, environmentPassed, builds:{inspected:<model sha256>, scratch:<build id>|null}, compiler:{package, version}, ticks:{inspected, scratch|null}}`; `null` when none ran. Absent and `null` stay valid; a present value must have this shape. The results themselves are not recorded: the AI receiving the review reruns the same `rigc render` readings on the named builds.

**Requirements (#113).** `GET /api/requirements` (single review) answers what the handoff's rig spec offers: `{status:"ready"|"unavailable", reason, bones[], slots[], meshes:{<slot>:[mesh attachment]}, slotBones:{<slot>:<bone>}, constraints:[{name, type:"ik"|"transform", bones[], drives[]}], animations:[{name, duration}], scratch:<build id>|null}`. `POST /api/requirements` (same-origin, capability, 64 KiB) takes exactly `{fps, build:"inspected"|"scratch", requirements:[1–64]}`, each requirement an object of at most 12 lower-case keys whose values are names, finite numbers or a `{bone, point}` / `{stage:[x, y]}` target; `may_fold` is refused. Malformed: HTTP 400 `REQUIREMENTS_REQUEST_INVALID`. Which kind, field, name or bar reads is the producer reader's to say. Outcomes (HTTP 200 `{status:"refused", error}`): `MODELING_HANDOFF_MISSING`, `MODELING_INPUT_UNAVAILABLE`, `REQUIREMENTS_NO_SCRATCH`, `MODELING_PRODUCER_NOT_INSTALLED`, `REQUIREMENTS_STATE_INSIDE_PACKAGE`, `STATE_DIRECTORY_INVALID`, `REQUIREMENTS_BUSY`. Review writes `{spec:"spine-parts-requirements/1", fps, requirements}` (one-space JSON and a newline) as `requirements.json` in `<state>/requirements/<package hash>/<run id>/` and runs `rig-parts check --rig <the handoff rig, or the latest scratch build's rig spec> --out out --parts <handoff parts> --requirements requirements.json` there; the directory is removed after the run. The job (`GET /api/requirements/<id>`): `{schema:"rig-review-requirements/1", id, status:"running"|"checked"|"refused"|"failed", build, buildId, file:{sha256, size, text}, producer, exitCode, wallMs, rows:[{name, kind, animation, status, measured, least, greatest, worst:{frame, time, text}|null, reason, line}], summary, checkLine, refusals[] (`REQUIREMENTS_*` lines verbatim), problems[] (`CHECK_REQUIREMENT_MET` / `CHECK_REQUIREMENT_MEASURABLE` lines verbatim), error, lines[]}`; rows come from `check.json`'s `requirements` block, else from the printed `NAME: STATUS — …` lines.

**Self-targeted requirements (#142).** The panel refuses before Add, as `REQUIREMENTS_SELF_TARGET`, a `contact` whose target is its own bone and point and an `aim` whose target bone is the aimed bone: both measure 0 in every frame and the producer reports them as PASS (its own refusal is rig-c/parts#540). A bone's tip against its own origin is not refused; it measures the bone's length. A fresh contact or aim form proposes a target bone other than the subject (the next bone in rig order).

**Retarget (#114).** `GET /api/rebuild` adds `retarget: {available, reason, producer, compiler, rig, sequences:[{id, label, path, cleaned, frames, people[]}], bones[], animations[]}`: the installed `@rig-c/pose` (found as `@rig-c/parts` is: the nearest `node_modules` from the package, then from review's working directory; `RETARGET_PRODUCER_NOT_INSTALLED` when absent, never installed) and the `@rig-c/core` beside it (legacy `rig-c` only when the scoped package is absent; `RETARGET_COMPILER_NOT_INSTALLED`). The `compiler` record identifies the selected package and version; the remaining inputs are the package's declared `rig-pose-sequence/1` pose references, and the handoff rig's bone and animation names (`RETARGET_SEQUENCE_UNAVAILABLE` when the package declares no sequence). `POST /api/rebuild` with exactly `{retarget: {sequence, map, flags, configHash}}` (same-origin, capability, 64 KiB): `sequence` a declared pose reference id; `map` a `rig-pose-map/1` document of at most 32 KiB whose chains each hold a name and 1–32 bones and joints (everything else is the producer's to judge); `flags` exactly `{animation, person, clean, minScore, flip, short, bends, bendTolerance, legScale, plantFeet, stance, raisedByHead, carryIdle}`, `clean` null or exactly `{loop, legs, rest, hold, hipsInferred}` (windows 1, or odd and 5–61). Malformed: HTTP 400 `RETARGET_REQUEST_INVALID`. Refused before anything runs: `REBUILD_CONFIG_STALE`, `RETARGET_SEQUENCE_UNKNOWN`, `RETARGET_SEQUENCE_UNSUPPORTED` (a static pose), the handoff and state-directory refusals, `REBUILD_BUSY`. The server maps the flags to argv (`op.args` for retarget, `op.clean` for clean, only what the flags state) and runs, in `<state>/rebuild/<package hash>/<retarget id>/`, `rig-pose clean --pose pose.json --out pose.clean.json <op.clean>` (unless `clean` is null) and `rig-pose retarget --rig <handoff rig> --map map.json --sequence <pose.clean.json | pose.json> --out motion.json <op.args>`, copies the handoff rig's regular files (motion.json excepted) and `images/` to `rig/` with `rig/motion.json` the retarget's, then the shared tail: the per-file diff and `rigc build --rig rig/rig.json --motion rig/motion.json --out build --profile rig-play --pack --page-edges free --pack-shape polygon`. The retarget id hashes the package, the handoff config, the record's bytes and both tool versions (no clock); an identical retarget reuses its build. The job (`GET /api/rebuild/<id>`): `{schema:"rig-review-rebuild/1", kind:"retarget", op:"retarget", id, status, reused, request:{record, recordSha256, configHash}, producer, compiler, lines[], producerLine, refusals[] (every FAIL line of the step that refused, verbatim), exitCode, wallMs:{clean, retarget, compile}, files, motion:{animation, animations[], kept, changed[], animationSha256, motionSha256}, readings:[{code, line, frame, time}], build}`. `readings` are the retarget's FEET, STANCE, FLIP, SHORT, END-ON, LEG-SCALE and REACH lines (at most 200), each with the first frame it names and that frame's key time from the run's report `frameTimes` (else the line's `t=`). The record, `rig-review-retarget/1`: `{schema, config_sha256, rig:{path, sha256 (rig.json)}, sequence:{reference, path, sha256}, map, map_sha256 (the bytes of map.json as written: one-space JSON and a newline), flags, producer:{name, version}, op:{cmd:"retarget", args, clean}}`; a reader checks that `op` is its flags' own argv. The applied context of a built retarget is `rig-review-applied/4`: `{schema, buildId, retarget, recordSha256, configHash, producer, compiler, line, motion, files, readings, modelHash}`.

**`context.environmentSchedule`.** Feedback written while the Environment controls are applied carries the drawn clip's exported schedule by hash and content: `{schema:"rig-review-environment-schedule/1", sha256, size, text, usedForReadings}` — `text` is exactly the exported bytes (a `rigc-environment/1` schedule), `sha256` and `size` are recomputed over it on save, `usedForReadings` says whether readings and Apply read it. Absent and `null` stay valid. The issue export adds an `Environment schedule:` line.

**`context.requirements`.** Feedback written while requirements are declared carries the file by hash and content: `{schema:"rig-review-requirements-context/1", sha256, size, text, checked:{build, producer, summary, refusals[], rows:[{name, status, worst}]}|null}` — `text` is exactly the bytes the producer reads, `sha256` and `size` are recomputed over it on save, and `checked` is the last check of those same bytes. Absent and `null` stay valid.

A `rig-review-applied/2` record whose `check.pass` is `false` is refused at submission (`PUT /api/session`) as `EDIT_SUBMIT_UNCHECKED: applied build failed check — <check's "check: FAIL …" line, else the first bar check.json marks FAIL>`; the build may still be loaded and looked at. `GET /api/rebuild` also returns the handoff config's `constraints` list as written (or `null`), which the physics tuning panel maps against the inspected model.

**Mesh panel (#106).** `GET /api/rebuild` also returns `meshes`: every `meshes.<part>` entry of the handoff config as written (`{}` without a handoff). The panel's Apply is an ordinary patch, exactly one op, run by remesh:

```json
{"schema":"rig-review-config-patch/1","config_sha256":"<…>",
 "ops":[{"op":"replace","path":"/meshes/topwear","value":{"contour":{"tolerance":2,"margin":2,"spacing":20,"maxEdge":45,"regions":[{"name":"chest","shape":"circle","cx":414,"cy":342,"r":50,"bone":"chest","spacing":13,"band":30}]},"r":15,"segments":[["chest",[416,230],[416,600]]]}}],
 "producer":{"name":"@rig-c/parts","version":"1.42.0"},"op":{"cmd":"remesh","args":["--part","topwear"]}}
```

The page refuses before sending a patch that is not that one op (`MESH_PATCH_SCOPE`) and an entry the config loader would refuse, in the loader's names (`CONFIG_MESH_MODE`, `CONFIG_FIELD_PRESENT`, `CONFIG_FIELD_TYPE`, `CONFIG_REGION_NAME_UNIQUE`, `CONFIG_NAME_RESOLVES`, `CONFIG_RIBS_MODE`, `CONFIG_STRAY_MODE`, `CONFIG_KEY_KNOWN`); the server's own rule is the patch rule above (`EDIT_PATCH_OUT_OF_SCOPE` outside `/meshes/<part>`). A remesh patch's job adds `remesh: {part, before, after, modelTriangles}|null`: `before` and `after` are `remesh.json`'s `target` counts (`{vertices, triangles, hull}`, spec `rig-parts-remesh/1`), `modelTriangles` the compiled scratch model's triangles for that slot's mesh attachment (null when it draws none), and the job's lines carry `review: remesh.json <part>: v … t … → v … t …`. The panel edits the grid and contour modes; an `auto` entry is shown without controls and `influence` is not offered (the installed `remesh --help` names grid, contour and auto entries).

**Chest landmarks (#105).** `{part, bust, configHash}` names a contour part and a `contour.bust` entry, typed as the producer's loader types it: `bust` holds exactly `apex_r`, `apex_l`, `cleavage` (each `[x, y]` in rig px on the 1/256 grid) and optionally `alpha` (> 0), `clearance` (a number), `bone_r`, `bone_l` (bone names) and `spacing` (> 0); any other key, an off-grid point or a missing point is `REBUILD_REQUEST_INVALID`. The server writes `mesh.json` as the part's config entry with `contour.regions` removed and `contour.bust` set (keys in the producer's order: `apex_r, apex_l, cleavage, alpha, clearance, bone_r, bone_l, spacing`, only those given), every other field as written, and runs the same `rig-parts remesh --mesh mesh.json` as #99. Example entry:

```json
{"contour": {"tolerance": 2, "margin": 2, "spacing": 28, "bust": {"apex_r": [384, 345], "apex_l": [446, 345], "cleavage": [415, 350], "alpha": 0.22, "clearance": 3.8}}, "r": 15}
```

The producer derives `bust_r` / `bust_l` (`R = round(d − clearance)`, `r = round(alpha × R)`, `band = R − r`, centre on the apex) and refuses `CONFIG_BUST_CLEARANCE`, `CONFIG_NAME_RESOLVES` and `CONFIG_REGION_NAME_UNIQUE` by name; the job's `request` carries `bust` beside `regions` (review's derivation, recorded, never sent). Clearance and bones are not judged by the server: the page refuses `CONFIG_BUST_CLEARANCE` before Apply on the producer's own test, and anything else is the producer's line verbatim.

**Physics live preview (#206).** The page uses exactly published Play 1.14.0. Only pending ops for source-matched editable constraint rows feed `setPhysicsParameters(name, patch)`, restricted to `strength`, `damping`, `inertia`, `wind`, `gravity` and `mix`. `mass` and component toggles remain producer Apply inputs only. `readPhysicsParameters(name)` supplies both the pending `override` and last evaluated `effective` snapshots for the preview label. Set/clear themselves neither evaluate nor move time or reset integrated history. The next evaluation applies overrides after authored/keyed values and sliders, before integration; a paused page explicitly calls `repose()` at the held time and draws. Clear preview removes the overrides and disables preview while keeping every pending patch op. Authored values resume at the next evaluation, preserving history rather than undoing motion caused by old values. Apply and model replacement clear preview; Reset also clears pending ops. No preview preference, parameter snapshot or override is added to the draft, patch, `context.applied` or feedback. The draft still contains only the existing pending edits; Apply's request and producer route are unchanged.

Play retains the standing patch across new play, seek, skin replay and composed-track promotion, without a historical journal. A backward seek after an edit recomputes the interval using the patch standing now. A new track evaluates its ordinary authored first pose before receiving that patch as pending: at seek time 0, `override` can report the patch while `effective` still reports authored values until the next evaluation. Unknown/non-physics names, unsupported fields, non-finite values and calls without a live track keep Play's named refusals. Preview never opens a track or writes an input asset.

**Idle tracks (#104).** `GET /api/rebuild` also returns `idle` (or `null` without a handoff): `{source, keying}`. `source` is `{available:true, source:{duration, tracks[], blink|null, bones[], chains:{<chain>: <links>}}}` — `config.motion` read for its shapes only (a single track `{bone, prop, amp, period, phase, base?}`, `prop` one of rig-parts' `rotate translatex translatey scalex scaley shearx sheary`; a chain track `{chain, amps[], period, phase, lag}`; the blink as written), the bones `config.bones` declares with chain links expanded (`<chain>0…`) — or `{available:false, reason:"IDLE_TRACKS_UNAVAILABLE: …"}`. `keying` says where the inspected idle keys each track, read off the handoff rig's `rig.json` and `motion.json`: `{keys:"ctl"|"direct", source, keyed:{"<config bone>.<prop>": "<keyed bone>"}, controls[]}` (`direct` when `rig.json` declares `invariants.idleDrivesMeshes`, which `rig --idle-keys direct` writes; otherwise `ctl`, the producer's default, under which a keyed bone a mesh is weighted to is keyed on `<bone>_ctl`), or `{error:"IDLE_KEYS_UNKNOWN: …"}`. The panel's edits are ordinary config patch ops: field ops at `/motion/tracks/<i>/<field>` (and `/motion/tracks/<i>/amps/<k>` for one chain link) on the config's own indices, then removed tracks as `remove /motion/tracks/<i>` from the highest index down, then added tracks as `add /motion/tracks/-`, then `/motion/blink/<field>`; Apply sends them as one `rig` patch with `--idle-keys <keying.keys>` (no flag when the keying could not be read); track and blink-number edits run `retune` on parts 1.44.0+ (*Routing*). The local draft's `#idle-pending` record is `{schema:"rig-review-idle-draft/1", ops}` and is restored only when the ops are exactly the ones the panel writes for the idle they describe. The preview is page state only: it is in neither the draft, the patch nor `context.applied`. Its `BoneAdjust` uses Play's `ctx.trackTime` (track-0 unwrapped evaluation time), including seek replay, and the composed turn adjustment receives that same context. Review does not read displayed `player.time` in the adjustment and never adds a compensating re-pose after seek. Bit-exact seek/continuous equivalence is for an unchanged patch, animation, environment, reset and step partition, as Play documents.

The issue export adds an `Applied:` line for a valid record (`patch <hash>… (rig; replace /constraints/0/damping) with @rig-c/parts 1.42.0 · check PASS · rig.json differs at 1 path(s) · motion.json, sets.json, mesh_report.json unchanged · 31 images unchanged · model <hash>…`; a record without `files` says `rig.json differs at N path(s)` alone); the raw context follows it. The review's `reviewedSource` still names the inspected build.

**Bones (#109).** `GET /api/rebuild` also returns `bones`: the handoff config's `bones` list as written (or `null` without a handoff). The Bones block's edits are ordinary config patch ops, `{op:"replace", path, value:[x, y], name}` with `path` one of `/bones/<i>/at`, `/bones/<i>/points/<k>`, `/bones/<i>/tip` (rig px) and `name` the entry's `name` — a chain entry, which has none, is named by its `chain`, and `EDIT_PATCH_NAME_MISMATCH` checks it the same way. Apply sends them as one `rig` patch (no flag), so it needs the reproduced baseline. `POST /api/bones-check` (single review; same-origin, capability, 64 KiB) takes exactly `{ops, configHash}`; every op must be such a `replace` (anything else is HTTP 400 `BONES_OP_OUT_OF_SCOPE`), and the patch refusals apply (`EDIT_PATCH_STALE`, `EDIT_PATCH_NAME_MISMATCH`, `EDIT_PATCH_PATH_MISSING`, `EDIT_PATCH_PATH_HELD`; producer resolution refusals verbatim; `BONES_CHECK_BUSY`), as HTTP 200 `{status:"refused", error}`. It writes the patched config (`scratchConfigText`) to `<state>/bones-check/<package hash>/<ops hash>/config.json`, runs `rig-parts propose --parts <handoff parts> --source <handoff source> --out propose --from-config config.json` and `rig-parts compare --left <handoff config> --right config.json` there, removes the directory, and returns `{schema:"rig-review-bones-check/1", status:"checked", request:{configHash, opsSha256, ops}, producer, propose:{status:"ran"|"unavailable", exitCode, wallMs, lint[], summary, coverage[], line}, compare:{exitCode, wallMs, origins:[{bone, distance|null, tip|null, text}], summary[], line}}`. `propose.line` is the LINT count line, propose's named refusal when it exits non-zero without a LINT line, or — when the handoff has no source painting, declared or discovered (#329) — `MODELING_INPUT_UNAVAILABLE: source painting — propose --from-config reads the painting (--source) and the handoff declares none; declare it with rig-review open <dir> --config <path> --source <png> --full <dir> or the review.json "producer" block`. Nothing is written into the package.

**Rig fields (#110).** `GET /api/rebuild` also returns `fields`: the handoff config's `regions`, `motion.blink` (as `{motion:{blink}}`), `stops`, `bones` and `turn` as written, an absent section left out (or `null` without a handoff). The Rig fields block's edits are ordinary config patch ops, each at its field's pointer (rig-parts AUTHORING §3): `{op:"replace", path:"/regions/<part>", value:<bone>}`; `{op:"add", path:"/motion/blink/still/<part>", value:{row, bone}}` (preceded by `{op:"add", path:"/motion/blink/still", value:{}}` when the config states no `still`) or `{op:"remove", path:"/motion/blink/still/<part>"}`; `{op:"replace", path:"/stops/<i>", value:<the entry with inward / outward changed>, name:<its chain>}`; `{op:"add"|"remove", path:"/bones/<i>/inherit", value:<mode>, name}` or `path:"/bones/<i>/link_inherit", value:{<link>: mode}`; `{op:"replace", path:"/turn/pivot"|"/turn/depths/<part>", value:<number>}`. A `stops` entry is named by its `chain` and `EDIT_PATCH_NAME_MISMATCH` checks it as it checks a `bones` entry. The page refuses anything else before sending (`RIG_FIELDS_OP_OUT_OF_SCOPE`; `turn.deform` is out of scope) and sends the ops as one `rig` patch (no flag), so it needs the reproduced baseline: none of its pointers is in retune's scope (*Routing*). The producer judges every value and its refusal comes back verbatim as the job's `producerLine`. The turn dial is play's `adjust` on the drawn build's `turn` bone; it is not a patch op and nothing records it. Nothing is written into the package.

**Undo across Applies (#166).** The session's applied records are a stack, in order, each with its build id; the last is on the stage. `GET /api/rebuild/history` (single review) answers `{schema:"rig-review-applied-history/1", depth, records:[{id, kind:"regions"|"patch"|"delta"|"retarget", op, what, modelHash, kept}]}` (`kept`: the record's build is still on disk). `POST /api/rebuild/undo` (same-origin, capability, 1 KiB) takes exactly `{from}`, the build id the page shows on the stage; it removes the last record and returns the stage to its predecessor's build, or to the inspected build when none is left: `{status:"built", undone, job, history}` (the predecessor's job, its model served at `/rebuild/<id>/` again), `{status:"running", undone, job}` (an evicted predecessor re-running; poll `/api/rebuild/<id>`), or `{status:"inspected", undone, history}`. Refusals (HTTP 200 `{status:"refused", error}`): `UNDO_NOTHING_APPLIED`, `UNDO_STALE` (`from` is not the last record), `REBUILD_BUSY`, and `UNDO_PREDECESSOR_CHANGED: <what>`; malformed: HTTP 400 `REBUILD_REQUEST_INVALID`. The scratch root `<state>/rebuild/<package hash>/` still holds only the build on the stage; the other records' builds wait in `<state>/rebuild-kept/<package hash>/<id>/`, at most `MAX_KEPT_BUILDS` (8) builds per package on disk counting the stage's, the oldest record's evicted first, and a build no record names is removed. A kept predecessor is moved back and re-hashed (every file the model names) against both its result.json and its record; an evicted one re-runs its recorded request through the same runner, refused before anything runs when the handoff config's sha256 or the producer or compiler version is not the record's (`UNDO_PREDECESSOR_CHANGED: <config path> sha256 a… → b…`, `UNDO_PREDECESSOR_CHANGED: @rig-c/parts 1.49.1 → @rig-c/parts 1.50.0; …`), or when its build id hashes differently (`UNDO_PREDECESSOR_CHANGED: build id a… → b… — …`), and refused after the run when the build is not byte-identical, by the first differing file (`UNDO_PREDECESSOR_CHANGED: skeleton.model.json — the record's build has sha256 a…, the re-run wrote b…; …`) — never guessed; a refusal leaves the stage and the stack on the last Apply. The undone record's build is removed (no redo). Undo writes nothing into the package. Feedback written after an undo carries the post-undo record as `context.applied` (or `null` on the inspected build), never the reverted one. The Cuts and Cloth blocks read the same record (#172): a `rig-review-applied/2` record with op `build` is the Cuts block's, with op `cloth` the Cloth block's, and a pending op is marked applied only while that record holds it (same op, path, value and name); their readouts show the restored build's job when it is theirs, else nothing. The stack lives in the review process; a restarted review starts with none.

**Density strip (#173).** Next to the selected part's density field — `grid` on a lattice entry, `contour.spacing` on a contour entry — the Mesh panel takes "N values from A to B" (2 ≤ N ≤ 5; a lattice's grid is rounded to whole numbers) and **Build strip** sends one Mesh-panel patch per value (the pending entry with that field at that value, `replace /meshes/<part>`, `remesh --part <part>`) to `POST /api/density-strip` (single review; same-origin, capability, 320 KiB = five 64 KiB patches) as exactly `{patches}`. Malformed (HTTP 400): `DENSITY_STRIP_REQUEST_INVALID` (not 2–5 patches, a repeated value, another config hash, producer or flag set), `MESH_PATCH_SCOPE` (a patch that is not the panel's one op) and `DENSITY_STRIP_FIELD` (entries that differ anywhere but the density field, or a mode without one); each patch is then refused as an Apply refuses it (`EDIT_PATCH_STALE`, `EDIT_PATCH_NAME_MISMATCH`, `EDIT_PATCH_PATH_HELD`, `EDIT_PRODUCER_MISMATCH`, the producer-resolution lines), before anything runs. The strip id hashes the package, the config bytes, every patch's bytes in order and both tool versions; each candidate's build id is the patch's own Apply id (*Run*, above).
- **Runner.** Every candidate runs the patch runner a remesh Apply runs — remesh into `rig/`, the compile with remesh.json's pack flags, #174's carried check (no third check; an older producer runs check, as an Apply does), the build hashed and `result.json` written — into its own folder `<state>/density-strip/<package hash>/<strip id>/<build id>/`, at most `min(4, max(1, floor(cores / 2)))` at once (the strip's `concurrency`; explicit limits are also capped at four). A candidate does not land: no applied record, no `latest` build, nothing in the Apply scratch root or `rebuild-kept`, no undo entry (#166's stack is untouched). One producer workload runs at a time per review: a strip is refused while an Apply (or undo's re-run) runs, and an Apply, an undo and another strip are refused `REBUILD_BUSY: density strip <id> is still running` while a strip runs; a single Apply is otherwise unchanged (its records, ids, scratch and lines).
- **Shared input check (#179).** On parts 1.55.0 or later, the first candidate asks remesh for `--record-input-check`. When remesh succeeds, Review moves its `input-check.json` out of `rig/` into the strip's folder, before the ordinary revision hash binding: the auxiliary record is not a revision file, and the revision binding still rejects every unexpected or changed file. The remaining candidates pass that record as `--input-check`, over the same absolute inspected rig and parts directories, unchanged bytes, tools and pack flags. The producer validates the record and refuses malformed or mismatched input by name; Review never retries without it. A refused seed has no record: its refusal stays on its row and the next candidate tries to record. A successful producer that leaves no available regular record refuses `DENSITY_STRIP_INPUT_CHECK_MISSING`, and the remaining rows refuse without starting a producer. A valid record releases the other slots while the seed finishes compiling; the seed counts toward the four-candidate limit. Older producers receive neither flag and still measure each input. The record stays private to this strip: it is never served, adopted with a candidate, or reused by a later strip; replacement/close removes it. The revision is always checked, and a strip still approves nothing.
- **Rows.** `GET /api/density-strip/<id>` (or `GET /api/density-strip` → `{strip}`, the one on screen or null) answers `{schema:"rig-review-density-strip/1", id, status:"running"|"done", part, field, concurrency, configHash, producer, compiler, wallMs, rows[], labels:{fewest, widest}}`, one row per patch in the request's order: `{value, id, status, counts:{vertices, triangles}|null (remesh.json target.after), modelTriangles, folds (ANIMATIONS_DO_NOT_FOLD's folding mesh count), stretch:{severity, frame}|null (the part's TEXTURE_STRETCH per-mesh severity and the frame of the side it came from), bars:[{bar, status, key, value, bound, kind:"floor"|"ceiling", ratio, margin}] (every bar line that measures the part — "part <name>," or "slot <name>," not unmeasured — its figure against the line's <key>_floor or <key>_ceiling), verdict ("PASS", check's line when it did not pass, or the refusal verbatim, e.g. "FAIL  REMESH_CHECK_HELD: …"), modelUrl, modelHash, applied, entry}`. The figures are the producer's own printed check of the revision (`[check-revision] …` lines; the lines of review's check when it ran one). `GET /api/density-strip/<id>/<build id>` is the candidate's job in full. `labels.fewest` is the passing row with the fewest triangles; `labels.widest`, when passing rows tie on that count, the one whose narrowest margin over its bars is widest (margin = value/floor, or ceiling/value). Labels only: the table has no Apply.
- **Load is not Apply.** A built row's model is served read-only at `/density-strip/<id>/<build id>/<file>` (its hashed files only; a refused row has none and cannot be loaded). Load puts it on the stage as **pending** through the same in-place reload an Apply uses (camera, animation, time, world kept) and sets the Mesh panel's pending entry to the row's entry; the counts line shows `MESH_COUNTS_AGREE` / `MESH_COUNTS_DIFFER` for the row. Nothing is recorded: while a pending row is on the stage the feedback context's applied state is null (nothing applied is on the stage), Undo is unavailable (the stage is not the last record), and **Back** returns the stage to what it showed. The Mesh panel's Apply then sends the same patch; its build id is the candidate's, so the server moves the candidate's folder into the Apply scratch root and the ordinary reuse re-hashes and lands it — one applied record, exactly as a re-Applied patch, with no producer run. The row then reads `applied` and is no longer served from the strip. Opening, building or loading a strip approves nothing.
- **Refine between** two adjacent rows builds the next strip with N values strictly inside their interval.
- **Scratch.** A package keeps at most one strip on disk: a new strip removes its predecessor's folder before it starts, `POST /api/density-strip/close` (same-origin, capability, 1 KiB, exactly `{id}`; `DENSITY_STRIP_BUSY` while it runs, `DENSITY_STRIP_NOT_FOUND` for another id) removes it, and a refused candidate leaves no folder. A restarted review starts with no strip; the next strip removes what a previous process left. Nothing is written into the package.

## Mesh edit export

Edit Mesh's **Download JSON** (#80, setup space since #100) saves two files; neither is written into the package and neither enters the review session.

`mesh-edit.json` is the delta, in the shape the producer's `rig-parts remesh --delta <mesh-edit.json>` reads (rig-c/parts 1.44.0) without conversion:

```json
{"schema":"rig-review-mesh-edit/1","slot":"panel","skin":"default","attachment":"panel",
 "source":{"vertexCount":5,"triangleCount":4,"hullLength":4,"hash":"<sha256>"},
 "units":"setup-pose crop px of the rig canvas, x right, y down; …","basis":"setup",
 "preview":"preview only — the producer retriangulates; …",
 "ops":[{"op":"move","v":4,"from":[5,5],"to":[6.5,4]},{"op":"edge","a":0,"b":2},{"op":"add","at":[5,0],"onEdge":[0,1]},{"op":"remove","v":3}]}
```

- **Space.** Every position is a setup-pose crop pixel of the rig canvas, x right, y down: the attachment's full-double world coordinates from published Play 1.13.0's `readSetupMesh`, including selected setup-slider deform, mapped by the model stage (`world = (x − width/2, height − y)`, root at the world origin). `basis` is always `"setup"`; the producer refuses any other basis (`REMESH_DELTA_BASIS`). A package without the model document has no setup mesh: Edit Mesh refuses `MESH_EDIT_MODEL_UNAVAILABLE` and exports nothing.
- **Source.** `vertexCount`, `triangleCount` and `hullLength` are the stored entry's (`uvs`/`vertices`, `triangles`, `hull`; the first `hull` vertices, in order, are the outline). `hash` is the SHA-256 of `JSON.stringify` of the attachment's entry (`skins[name].attachments.<slot>.<attachment>`) in the hash-verified model document. The producer holds both to the input part's own (`REMESH_DELTA_SOURCE`) and requires `skin` `"default"` with `slot` and `attachment` the part's name. A linked mesh is not editable (edit its source). Geometry, triangles and hull come directly from that API. A never-played player reads only the public setup identity (setup sliders may change it); its active skin selection is passed independently of the supplying table used to read stored provenance. A hidden/null setup identity stays unavailable with its public reason, without attachment inference.
- **Ops**, in order, at most 300: `move {v, from, to}` — `from` is the vertex's exact current position, unrounded (the producer refuses a `from` more than 1e-3 px off), `to` rounded to 0.01 px; `add {at, onEdge?}` — the next id, splitting edge `onEdge` when given; `remove {v}` — the vertex and its triangulation edges, never a vertex that ends a constraint edge; `edge {a, b}` — a constraint edge; `unedge {a, b}` — only a constraint edge this delta added (hull and triangulation edges are the producer's; review refuses `MESH_EDIT_HULL_EDGE`, `MESH_EDIT_TRIANGULATION_EDGE` and `MESH_EDIT_CONSTRAINT_END` before recording). Vertex ids are the attachment's indices; an added vertex takes the next id; a removed id is never reused. Each op carries exactly these keys.
- `units` and `preview` are text for a reader; nothing reads them.

`mesh-edit.binding.json` (`rig-review-mesh-edit-binding/1`) binds the delta: `file {name, sha256}`, the package source hash, the model and motion SHA-256, `attachment {slot, skin, name, sha256}` (the same `hash`), `exportedAt`, the viewer and runtime versions, `mapping` (the crop mapping's basis) and an evidence note. Apply · Rebuild (#135) sends the same document as `{part, delta, configHash}` (bounded to 64 KiB, same-origin); the server writes it with the download's bytes and runs `rig-parts remesh --delta mesh-edit.json --part <part>` over the handoff rig (`@rig-c/parts` 1.43.0 or later, else `MODELING_PRODUCER_TOO_OLD <found> 1.43.0`). The producer computes `source.hash` from its own rigc build of the input and refuses a mismatch (`REMESH_DELTA_SOURCE`), a non-setup basis (`REMESH_DELTA_BASIS`) and an op that does not replay (`REMESH_DELTA_OP`); each line is shown verbatim. A built revision's `context.applied` is `rig-review-applied/3`: `{schema, buildId, part, delta, deltaSha256, configHash, producer, compiler, line, op: "remesh", files, mesh?, modelHash}`. `deltaSha256` is the SHA-256 of the bytes written, which equal the download's `mesh-edit.json`.

The live-job handoff uses [Mesh edits on Request changes (act@8)](#mesh-edits-on-request-changes-act8) and [Chest landmarks on Request changes (act@9)](#chest-landmarks-on-request-changes-act9). Standalone `--delta` and its download format remain available for legacy callers.

## Historical feedback retrieval

`feedback` and `feedback compare` first return the exact current-tool stored session, including an explicitly saved pending decision. A corrupt current record is refused rather than replaced with an older approval. Current-file reads use an explicit present/missing result, and the CLI rechecks current state before returning history so a concurrently saved pending review wins without relying on its timestamp. If the current file is absent, these CLI commands search prior saved submissions for the same immutable content. HTTP session reads and all saves retain their existing strict current-tool binding; history is not approval migration.

For a single package, matching requires the same id, revision, source hash, package revision and exact rig/motion paths and hashes (including null artifacts). Only recorded viewer/runtime versions may differ. Compare lookup requires ordered A/B content bindings, the exact reference name/hash and animation. Its historical combined hash, compare id and state filename are verified against that record's own recorded tool versions, because those identifiers also change on tool upgrades.

The result retains the original status, feedback, recorded `reviewedSource`/comparison binding and `updatedAt`, with optional `retrieval:{kind:"prior-tools",toolsChangedSince:true,matchingSubmissions,currentTools}`. `currentTools` is `{viewerVersion,runtimeVersion}` for single mode or `{a:{viewerVersion,runtimeVersion},b:{viewerVersion,runtimeVersion}}` for comparison. Multiple matching prior records select the latest valid saved ISO timestamp; equal timestamps use lexical state filename order. Approval receives no priority over a later pending or changes-requested submission. A null or malformed submission timestamp is refused, never promoted to a submitted review.

Discovery reads only regular `<64 lowercase hex>.json` files in the private state directory and never follows candidate symlinks or opens paths embedded in JSON. Historical candidate reads are bounded to 32 MiB per file and 64 MiB per search, and more than 100 unreadable candidate files produce a named refusal. Unreadable/nonregular/unparseable unrelated files appear as `historyWarnings:[{file,error}]` rather than fabricated submissions. A matching record with contradictory binding, filename or other invalid session data fails by name. A missing directory or no matching submission yields fresh current pending; content changes never inherit historical approval. Neither lookup rewrites a state file, source asset, model or motion.

Existing legacy-feedback warnings remain visible when a historical row fails today's target/interval rules. The original evidence and recorded tool identity remain available, while resubmission to the current server still requires a valid current binding and corrected feedback.


### Grouped issue export

`rig-review feedback <input> [--reference <video>] --format issue` and both comparison feedback forms accept the same explicit binding as their JSON output. Compare supports either `feedback compare <a> <b> --reference <video> --animation <name>` or `feedback <a> --compare <b> --reference <video> [--animation <name>]`; the latter retains open's unique-common-animation rule. `--format` is accepted only for feedback and only once, with `json` or `issue`; omitted format remains the unchanged JSON response. Formatting reads the existing current/history session once and never writes source or state.

The issue text header reports total records, defect/quality counts, and per-build defect/quality/total counts. A single review has one build row; comparison always has separate A/B rows even if hashes or target names coincide. Empty categories and sides report zero. Counts measure feedback records, not frame lengths, unique targets or report findings. Every feedback id produces one issue block, including legacy warning rows and overlapping intervals.

Blocks group in fixed category order (`defect`, then `quality`), followed by exact `(target.kind,target.name)` with deterministic code-unit ordering, then side and feedback id. Bone and slot names do not collide. Each block carries its original id, inclusive chosen frames, target, category, one-line summary, side and selected build's source hash/reviewedSource. Compare also repeats the complete ordered A/B/reference/animation binding so a copied block retains both source identities. Single external-reference blocks retain `referenceBinding` with the base package hash and selected video name/id/SHA. Missing rig/motion artifacts remain null. The original inspection context stays separate from chosen frames; no clock or category is inferred.

The header retains recorded status/timestamp and full source/tool provenance. Prior-tool retrieval is labeled as historical rather than current approval; original versions, currentTools and matching-submission count remain available. Server-derived per-feedback warnings and historical read warnings are included without discarding their items. Formatting does not make an invalid legacy item resubmittable. User text is escaped in Markdown syntax positions and inert evidence uses data-safe JSON fences, preserving arbitrary ids/targets/context without creating extra headings or rows. No issue is posted automatically.

## Read-only rig-pose report markers

A folder's root `report.json`, or a unique declared authoring file named `report.json`, is read only and remains part of the exact input hash. A JSON object with `spec: "rig-pose-report/1"` supplies normalized findings under `/api/review.report`; unrelated report objects remain evidence and supply null. An explicit manifest does not discover an undeclared report. Recognized malformed values fail by source field name. No report is rewritten and selecting a finding never submits a review.

The supported categories are `switches`, `raised`, `short`, `endOn`, `cleaned.holds`, `cleaned.seams`, `feet.jumps`, `feet.supports`, `landings`, `shear`, `artRange`, `uncovered`, `flips`, `turns`, `range`, and `holds`. Missing fields supply no category or synthetic marker. A supplied empty array supplies `{field, state:"empty", events:[]}` so the UI can show none. A null optional parent such as `feet` supplies no child categories. Top-level `holds` and `cleaned.holds` are different lists.

`report` contains `spec`, source `path`, optional producer `animation`, `rig`, `frameCount`, `durationSeconds`, optional frame metadata, nullable `clock`, and `categories: [{field,state,events}]`. Each event contains a stable `id`, source `{path,pointer}` (a JSON pointer), `field`, original `details`, actual named bone/slot `targets`, separate scan/chain/side `provenance`, and timing state. A source single `frame` normalizes to inclusive `frames:[n,n]`; a source `frames:[first,last]` retains both indices. Legacy top-level holds use `from/to` as frame indices. These indices are never derived from seconds. `joint`, `point`, `joints`, `chain`, `chains`, `side`, `set`, `attachment`, and `line` remain provenance; none implies a rig bone. Switch `slots` keys are actual slot names. A producer `bones[]` supplies all explicitly mapped bone choices, deduplicated by kind/name alongside singular targets; no joint-name inference or first-target selection is added. Original details and scan provenance remain intact. All candidate names still require model membership when feedback is submitted.

Timing is deliberately explicit:

- `seek:{time,source}` appears only with an event `t`, event `times`, switch `from`, an exact indexed root `frameTimes[]`, or the complete root pair `fps` and `frame0`. Uniform timing follows the producer contract `t = frame0 + frame / fps`: `frame0` is an offset in seconds, never an assumed zero. `frameTimes` are strictly increasing seconds, one per reported frame when the frame count is present, with no interpolation. Contradictory event and clock times are refused within a 1e-6 tolerance. If both root time-base forms are provided they must agree.
- Switch `timeInterval:{start,end,endKind:"boundary"}` preserves `from/to`: `to` is the boundary where the base art returns, not an invented last-frame timestamp. Explicit event `times:[first,last]` or a mapped frame interval uses `endKind:"frame"`.
- `uncovered.times[]` remains a discrete list of seconds, including every gap. It receives no invented frame interval or continuous time span. Its first explicit time is the default seek; each provided time remains selectable.
- Legacy `seconds` and optional `spanSeconds` are durations only, normalized as `durationSeconds`. Neither starts a seek. `frames` plus overall `duration` never implies FPS; unrelated event samples do not establish a clock for other events.
- `timing:"mapped"` means an explicit seek is available; `"frames-unmapped"` retains source frame coordinates but displays **시간 맵 없음 — seek 불가**. `"unavailable"` denotes an entry with no usable seek or frame coordinate (for example a provided empty discrete time list). No missing time receives zero.

For a legacy report with no declared full clock, frame-only markers remain visible with feedback frame prefills and unavailable seek; switch/from and uncovered/times can seek. The retarget report writer emits measured `frameTimes` and explicit time coordinates for pose-frame events ([rig-c/pose #209](https://github.com/rig-c/pose/issues/209)). Selecting a marker preloads only supplied frame coordinates and actual target choices. It neither guesses FPS nor maps scan joints to rig bones, and report measurements do not automatically mark a defect, category, checkpoint result or overall approval.


## Producer-frame transport

This unit accepts a clock only from the recognized source-bound report, not from a manifest or video metadata. `/api/review.report.clock` is null when absent, or one of:

```json
{"kind":"uniform","fps":24,"frame0":0,"frameCount":313}
{"kind":"samples","frameTimes":[1,1.08,1.41,2.9]}
```

The uniform example is an explicitly authored test clock; it is not a timing claim about the unchanged v19 report. `fps` is positive, `frame0` is a required offset in seconds, and frame `n` occurs at `frame0 + n / fps`. The declared uniform step must conservatively exceed floating-point resolution across its domain; numerically collapsed sample clocks fail by name rather than mapping two frame indices to one time. `frameCount` comes only from report `frames`; omitted frame count leaves uniform metadata unbounded and does not enable frame transport. The samples variant carries each exact producer timestamp, so its length supplies the last frame even without a separate count. No interpolation is performed.

The current frame is the greatest sample index whose timestamp is at or before the inspection time, only within the closed interval from the first sample to the last. Time before or after that domain is unknown; the last frame has no invented trailing duration. A one-frame clock is known only at its single timestamp, and an empty clock is unknown. Frame seeking accepts only a nonnegative integer through the declared last index and returns that sample's exact time. Broad epsilon snapping does not advance a genuinely earlier time to the next frame.

With a model player, the transport uses this clock only while the active animation exactly matches the report's named `animation`; other animations or a missing binding keep frame lookup unknown. The one other clock is a scratch build's own: after a Retarget Apply, the run's report `frameTimes` bind to the new animation and to that build's model hash, and the transport uses them for that animation when the package report has no clock for it. A source-only inspection can use its explicit report clock without inventing an animation identity. Unbounded or absent timing keeps frame lookup unknown. The seconds transport remains available independently. Bounded clocks show `F<n> / <last>`; outside their domain the frame is unknown. The unchanged v19 report displays `rate unknown`. An explicit 24fps, zero-offset test fixture shows F100 at `100/24`, displayed as 4.1667s; offset and irregular fixtures exercise the different declared times.

When feedback is added, `context.frame` is recalculated from the active clock and current inspection time, or recorded as null. Marker frame labels do not override that calculation. Existing inclusive feedback intervals remain producer annotations and are not inferred from the transport. No clock operation retimes or writes motion, source report or models.


## Two-package comparison

`review compare <a> <b> --reference <local-video> --animation <name>` opens two existing review manifests or output directories. `check compare` validates the same input contract; `feedback compare` retrieves its saved review. Both compiled models must contain the explicitly named animation. Raw skeleton evidence alone cannot open compare playback. This mode does not choose an animation by fuzzy name or borrow a frame rate from the video.

The reference is an explicit regular local `.mp4`, `.webm` or `.mov` CLI input. It is independent of each package's containment boundary; a package manifest cannot request an external reference or broaden the server's filesystem access. Each side retains its own existing allowlist and safe-file checks. Only `/compare-assets/a/<declared-path>`, `/compare-assets/b/<declared-path>` and the fixed `/compare-reference` are served. The latter always names the one selected video, never a supplied path parameter. No source file is copied into either package or rewritten.

`GET /api/compare` returns `mode:"compare"`, generated `id`, `title`, `revision:"compare/1"`, combined `sourceHash`, `animation`, `binding`, sides `a` and `b`, and `reference:{name,sha256,url:"/compare-reference"}`. Each side has its normalized `manifest`, `report`, `sourceHash`, `reviewedSource` and side-specific `assetsBase`. The binding is:

```json
{
  "a":{"sourceHash":"<package A hash>","reviewedSource":{"packageRevision":"...","viewerVersion":"...","runtimeVersion":"...","rig":{"path":"build/skeleton.model.json","sha256":"..."},"motion":{"path":"motion.json","sha256":"..."}}},
  "b":{"sourceHash":"<package B hash>","reviewedSource":{"packageRevision":"...","viewerVersion":"...","runtimeVersion":"...","rig":{"path":"build/skeleton.model.json","sha256":"..."},"motion":{"path":"motion.json","sha256":"..."}}},
  "reference":{"name":"reference.mp4","sha256":"<exact video bytes>"},
  "animation":"dance"
}
```

The combined hash is SHA-256 over this ordered binding. Swapping A/B changes identity; the reference hash, animation and both package hashes are load-bearing. The package hashes include declared model pages and other evidence, not just rig/motion documents. Paths in reviewedSource remain package-relative; absolute local input paths are not part of the API/export.

`GET /api/compare/session` and same-origin bounded JSON `PUT /api/compare/session` use:

```json
{
  "schema":"rig-review-compare-session/1",
  "id":"compare-<digest prefix>","revision":"compare/1","sourceHash":"<combined hash>",
  "binding":{"a":"<full A binding above>","b":"<full B binding above>","reference":"<exact reference identity above>","animation":"dance"},
  "status":"pending",
  "feedback":[{"id":"one","side":"b","frameStart":10,"frameEnd":18,"target":{"kind":"bone","name":"arm"},"category":"quality","summary":"Inspect this transition","context":{"time":0.5,"frame":null}}],
  "updatedAt":null
}
```

The abbreviated binding values in the example stand for the full objects above. Compare feedback has the single-package interval/target/category/summary contract plus required `side:"a"|"b"`. There is no "both" side or implicit default. The exact full binding and session identity must be returned unchanged. Both exports and each issue-ready item retain the side and complete paired provenance. Compare sessions are separate from single-package sessions and do not manufacture checkpoint outcomes.

Reads and saves reload both packages and stream-hash the shared reference. Any change or unreadable input returns HTTP 409 and requires restart; a package change cannot inherit approval through the unchanged side. A save rechecks after receiving its entire bounded body. Reference/asset reads support byte ranges without rehashing the full video for every chunk. Host, Origin, body size, literal paths and sandbox/no-store asset rules remain enforced.

One video playhead drives both published players with the same target seconds and fixed seek step; neither model runs an independent animation clock. Compare stops at the common valid domain instead of silently clamping or looping a shorter side. Frame coordinates use each side's explicit report clock independently; different clocks can give different frame numbers at one shared time, and missing clocks stay unknown. Seeking and feedback do not retime or author motion.

Core runtime time/bone checks and transport traces establish only the measured time/pose contract. Without a browser run, video decoding, requestVideoFrameCallback presentation and rendered WebGL/canvas pixels remain unexercised. A passing synthetic no-art model is not visual acceptance of private artwork.

## Derived frame strips

Strip export consumes the existing package without changing its schema, inputs or session. `POST /api/strip` and `POST /api/compare/strip` require the exact loopback Origin and bounded JSON (1MiB). The request is:

```json
{"format":"png","sourceHash":"<exact loaded hash>","animation":"dance","referenceId":"source-video","intervals":[{"id":"selection","basis":"single","frameStart":176,"frameEnd":184}]}
```

For compare, omit `referenceId` and choose `basis:"a"|"b"` per interval. Its video remains the fixed CLI input and animation remains the fixed comparison animation. A feedback batch supplies distinct ids, optional `feedbackId`, and each item's own inclusive interval/side. UI batches require matching explicit `context.animation`, including unsaved rows; CLI batches use the exact current saved session. Export does not assert that the selection is a validated or submitted annotation. Unknown request properties, including filesystem paths, are refused.

PNG responses are `image/png` attachment downloads; JSON responses are `application/json` attachments. Errors use `{error:string}`; changed source returns409. The JSON envelope is `{plan,rendering}`. `plan.schema` is `rig-review-strip/1`; it includes ordered source rows, each distinct interval group with requested frame/time samples, layout, animation, clock basis, exact aggregate hash, full reviewedSource for each package and video name/SHA. Compare also retains the complete original ordered comparison binding. No absolute input path is exposed. `rendering:null` explicitly means selection-only JSON, with no claimed decoding or pixels. A rendered CLI PNG sidecar additionally records dimensions, PNG SHA-256, renderer/version/backend and each requested versus actual reference sample, decoded index/delta, actual player times and side-specific frame coordinates.

Only selected-basis report `frameTimes` supplies strip times. A matching report animation is required. Uniform metadata remains supported by inspection transport but does not become a strip sampling substitute. A clockless JSON group keeps its inclusive frames and `time:null`; clockless PNG refuses with `Report has no frameTimes — regenerate with pose 0.30.0 or later`. A compare A without a clock remains renderable from B's explicit times and has no inferred A frame label. Each actual reference PTS is selected nearest to the request (ties earlier), and all rig rows use that same PTS. Requested/decoded times outside the common clip/video domain refuse, without a per-source clamp.

Each interval has its own source-row grid; overlapping groups preserve their feedback ids and repeated frames. Source packages and reference are checked before and after export, including exact model/page/motion bytes through existing package hashes. The PNG footer includes full rig/motion hashes (null stays absent), revisions, viewer/runtime and actual renderer versions. Exports are derived evidence, never a new source or approval. CLI destinations and `.json` sidecars must be new files. An existing output parent may be reached through a symlink, including macOS `/var`, if the physical destination is outside every source root. An existing destination entry, including a dangling symlink, is refused. Downloads have no arbitrary filesystem destination parameter.

The pure layout reserves a maximum `footerHeight` budget for complete provenance. The native renderer wraps the actual footer text before allocation and uses only that measured height; `rendering.width/height` records the actual PNG extent. Unsupported RGB/dark tint refuses by name (`STRIP_UNSUPPORTED_TINT`) rather than claiming Canvas2D pixel parity for features its published renderer omits. Labels and footer use concrete font-family lists, never a generic family (Node Canvas resolves those to the machine's first family); when no family of the mono or sans list is installed, rendering refuses `STRIP_FONT`, naming both lists, before any reference probe or drawing.

A strip plan with one clock basis reports `plan.basis:"single"|"a"|"b"`. A comparison batch containing both sides reports `plan.basis:"mixed"`; each group still carries its own `basis` and its own report-derived sample times. Consumers must use the group basis for a mixed plan rather than treating the first group as a batch-wide clock. The selected basis row labels requested producer frames/times; actual PTS and independently calculated actual frames remain separate rendering metadata. Output containment uses native platform separators, including Windows drive and UNC paths.

## Open-managed handoff and explicit single reference

`rig-review open <input> [--reference <local-video>] [--compare <input>]
[--animation <name>]` hashes and validates the input, starts/reuses a fixed-binding
background instance and follows the [launcher contract](../README.md#launcher-contract)
for stdout, stderr and exit codes. Existing `feedback compare ...` remains supported.
Open animation selection uses `--animation` first, a normalized report `animation`
second, and a unique actual model clip (or common A/B clip) last. Report metadata
comes from the exact already-hashed recognized report bytes, never a separately
opened JSON file. Equal A/B declarations or a declaration on one side select the
named clip only if both real catalogs contain it. Conflicting reports and stale
names refuse; explicit flags can resolve conflicts but invalid explicit names
never fall back. No frame count, FPS, duration or filename selects a clip.

Stdout remains URL-only. Stderr prints `animation: dance (from report.json)` for
the root-report case, the actual package-relative report path for other report
locations, `from --animation` for explicit flags, or `unique actual clip`.
Option values such as an actual animation named `--format` or `--help` are literal
values, not independent options. The old strip export grammar is unchanged.

The worker revalidates its resolved name and complete source binding before
startup. Its API provides `initialAnimation` (a validated name or null); the
single player uses it rather than the first runtime entry. Explicit checkpoint
links and subsequent manual choices override startup selection. With a selected clip, an automatic checkpoint is retained when its own
animation and any declared axis's resolved animation both match that clip. Its
time, camera, workspace and checkpoint identity remain intact. Conflicting or
unbound checkpoints and unresolved or conflicting axes are skipped so another
clip's time/axis cannot silently apply.
A static model with zero clips stays static. A source-only report can remain
evidence without claiming observed playback; an explicit name without compiled
catalog metadata refuses as validation unavailable.

Single source/session/reference hashes remain unchanged: startup selection
participates only in fixed-worker reuse identity, not clip-specific approval.
An explicit flag and report resolving to the same effective name reuse the same
worker. Different compare names retain the existing animation-bound ordered
comparison identity. The printed feedback command includes the effective name;
single feedback retrieval validates an explicit name without changing its
package-wide identity or stored review.

Single `--reference` is an explicit CLI-selected regular local mp4/mov/webm file.
It does not alter the source manifest, the package files allowlist or manifest
path validation. The HTTP response exposes `explicitReference:{id,name,sha256,
url:"/review-reference"}` and a view-only reference entry. The frontend consumes
that fixed URL instead of a package asset URL. Automatic startup preserves the
selected video; explicit checkpoint links and manual choices keep their declared
reference behavior. GET/HEAD/ranges on this endpoint re-resolve the original
canonical regular file, refuse symlink replacement, and verify the pinned full-video SHA before every response. Single and compare reference endpoints hash and stream the same opened descriptor with 64 KiB buffers; HEAD, rejected ranges, cancellation and completion close it. A detected same-inode change during streaming aborts the body; this is not an atomic snapshot against concurrent external writers. Both endpoints use the same sandbox,
nosniff and 206/416 boundary as package media. No arbitrary path is accepted by
HTTP. Review/session/save/export freshly rehash the complete source binding.

Referenced single sessions add:

```json
{"referenceBinding":{"packageSourceHash":"<base folder hash>","reference":{"id":"<selected id>","name":"original.mp4","sha256":"<video bytes hash>"}}}
```

The session `sourceHash` is the deterministic combined reference/content digest;
`reviewedSource` remains the actual unchanged rig/motion/tool identity. Strict
parsing requires the exact reference binding and includes this content in the
state key. Reference-free sessions retain their old contract. Retrieving without
`--reference` does not borrow approval from a referenced session. Historical
lookup over the same selected reference retains its originally recorded versions;
copying a package object for this read preserves the private reference capability.
Public JSON/Markdown contain relative artifact paths and video basename/hash,
never its absolute path. The selected video also works in the single strip panel
and `strip --reference-video <path>`; both use the same immutable binding and
post-render revalidation. The original `strip --reference <declared-id>` syntax
is unchanged.

Open-managed URLs have `input=<content hash>&handoff=<instance key>`. Missing or
wrong keys receive 409 before HTML is served. APIs remain fixed to that instance
and retain exact Origin/body validation; the URL is not a dynamic package picker.
A private bounded `/api/open-status` handshake requires its instance capability,
returns matching identity, and verifies current input hashes. The state registry
never makes a PID/port alone authoritative. Changed input, reference, mode,
canonical input location or actual tool source/static fingerprint gets a distinct
instance identity. Existing single foreground servers retain their direct lifecycle.
Plain multi-target foreground review uses the shared owner workspace registration
and capabilities described in [WORKFLOWS](WORKFLOWS.md#subsequent-cli-and-semantic-paths).
Neither path supplies a browser filesystem API.

Registry/request/log/claim files are private tool-state files; a per-binding claim
serializes startup, stale records are not reused, and no unrelated process is
terminated. Workers expire after 30 minutes without requests and clean only their
own nonce's registration. Startup waiting is bounded. `RIG_REVIEW_STATE_DIR`
changes the tool state root but cannot place it inside a source package, the
`rig-parts build` root a check package belongs to, or the producer handoff's root,
including through a symlink alias of the directory or an ancestor
(`OPEN_STATE_INSIDE_PACKAGE <package | build root | handoff root>`). Every runner that
writes state (rebuild, strip, bones check, readings, requirements, environment check)
applies the same canonical check and refuses with its own `*_STATE_INSIDE_PACKAGE`
code naming the folder. No package manifest, source video, motion or compiled
model is written by open. There is no browser launch or new LAN exposure.

Review resolves the existing directory prefix of a state path or explicit
parts verdict parent. An `ENOENT` suffix can be created when the command needs
it. A regular file in the directory path (`ENOTDIR`) or a symlink loop
(`ELOOP`) stops resolution. Parts verdict resolution preserves the original
output filename, and protected input collisions still refuse by name.
State guards return `STATE_DIRECTORY_INVALID` through the existing HTTP 200
refusal response on guarded routes.

| Input | Previous behavior | Current behavior |
| --- | --- | --- |
| Strip destination under a symlink to an existing directory outside the source roots | `strip.output` refused the symlink with the `without symlinks` suffix | Writes to the physical directory with the original filename |
| Strip destination with a missing parent | Raw `ENOENT` | `strip.output: parent must be an existing directory` |
| Strip destination with a loop in its parent path | Raw `ELOOP` if raised during lookup, or the earlier `without symlinks` refusal | `strip.output: parent must be an existing directory` |
| `open` state path through a regular file or loop | Raw `ENOTDIR` or `ELOOP` | `OPEN_STATE_INVALID` |
| `control` state path through a regular file or loop | Raw `ENOTDIR` or `ELOOP` | `CONTROL_STATE` |
| State guard sees a regular file inside the package with a requested suffix | `*_STATE_INSIDE_PACKAGE` | `STATE_DIRECTORY_INVALID` |
| State guard sees a symlink loop | Raw `ELOOP` | `STATE_DIRECTORY_INVALID` |
| Parts or atlas verdict parent through a regular file or loop | Raw `ENOTDIR` or `ELOOP` | `PARTS_VERDICT_DESTINATION_INVALID` |

The printed feedback retrieval command uses POSIX shell quoting for literal path
arguments. It is not a PowerShell or cmd.exe command string.

### Exact compare frame inspection

Comparison may read the fixed `/api/compare/reference-frames` endpoint to obtain
the explicitly selected reference's real ffprobe timestamps. The endpoint accepts
no path parameters, remains loopback/read-only, and rechecks the pinned reference
bytes before using its per-server cached index. Probe input/output is bounded;
missing ffprobe or duplicate PTS makes exact frame selection unavailable without
disabling basic seconds playback.

Frame inspection uses the same nearest real PTS policy as strip export (ties keep
the earlier PTS). The browser seeks inside that real frame's interval, then checks
the returned requestVideoFrameCallback timestamp against the selected decoded
index. This match uses nearest indexed PTS within the video's real half-open
`[0,duration)` domain: browser PTS may retain more digits than ffprobe's decimal
output at the first or final frame. No epsilon or video rate is inferred.
Both rigs still pose at the returned actual mediaTime. Requested producer
frame/time, decoded video index/PTS and actual player times remain distinct data.

A displayed **Review frame** is a unique explicit producer sample associated with
that decoded index by the same nearest-PTS selection. It is not an inferred video
FPS or a change to the producer's sample times. Missing clocks and ambiguous
multiple-sample associations remain unknown; association is bounded to100000
explicit samples. The original `frameAtTime` closed-domain floor rule remains
unchanged for existing consumers and raw feedback/trace fields. Raw floor frames
stay in trace details; requested producer indices and review associations are
additional fields, not renamed actual pose metadata.

A nearest-frame selection outside the shared clip domain is refused before the
video or valid inspection changes. Playback crossing a shorter clip end pauses
and explicitly inspects the final supported indexed PTS, reporting that timestamp
and the clip end rather than claiming a clamp to the requested end. Without an
exact index it pauses and invalidates inspection feedback; seconds controls remain
available for recovery. A decoded timestamp outside the shared domain likewise
leaves inspection unavailable without permanently disabling transport.

### Live compare submission timing

Each actual requestVideoFrameCallback mediaTime immediately poses both rigs with
fixed-history public seek and submits both draws. There is no pre/post admission
based on a historical draw-cost estimate. This synchronous path has no queued
newer JavaScript callback to drop; it does not invent an asynchronous scheduler.

The browser reports the current frame's expectedDisplayTime. Its completion
lateness remains a separate diagnostic. The **next-reference estimate** is
`expectedDisplayTime + (next actual decoded PTS - current indexed PTS) * 1000 /
video.playbackRate`. Adjacent timestamps come from the verified reference index,
not producer FPS, a guessed cadence, an epsilon or video slowdown. If the index,
next timestamp or positive finite playback rate is absent, timing is unknown:
basic playback continues but strict timing cannot pass. The final indexed frame
has no invented next interval. CPU draw-return time is submission completion,
not compositor acknowledgement or proof of pixel presentation.

`lastDrawn` changes only after both draw calls succeed. Prepared player.time is
reported separately. A failed second draw invalidates the pair. A late or
unknown-timing live submission cannot supply successful inspection feedback;
paused inspection has no deadline and can recover a valid pair. The transport
shows actual last-drawn time, reference drift, known/unknown timing counts and
late submissions without suppressing future drawing.

The manual measurement records every eligible live callback, actual presented
index gaps, last-drawn drift, paired pose/draw cost and both timing diagnostics.
It requires at least99% decoded-callback coverage and99% drawn-pair coverage,
full clip bounds and known paired state; all-held or endpoint-only runs fail.
The original1.11.0 baseline and first1.11.2 all-held failure are retained as
historical evidence. Runtime1.11.2 consumption does not itself certify performance:
acceptance requires independent actual measurement and the producer's corrected
physics oracle, with their scopes reported separately.

At the actual media `ended` event, comparison pauses and reuses exact inspection
of the last supported indexed reference frame. This restores valid endpoint
feedback without inventing a future display deadline. Missing-index fallback
keeps inspection unavailable and the existing supported-seek recovery path.

A terminal timing sample is N/A only when the bound verified index says it is
the last decoded frame exactly at the shared clip end, there is no successor,
an actual ended event follows it, and a later valid paused inspection confirms
the same actual last-drawn pair and enables feedback. The manual raw evidence
records all of those facts. Other unknown timing remains a strict failure; the
terminal case is excluded from the deadline denominator, never counted as an
on-time submission.


## Actual browser draw backend

Browser players retain play's default DOM mode and default mesh backend. Rigid
parts remain DOM images; a WebGL mesh label does not claim full-frame GL drawing.
WebGL is requested by the published default, with Canvas2D as the supported mesh
fallback. Accurate public actual-flush telemetry requires play 1.11.1 or later;
this checkout consumes pinned 1.25.0. The consumer does not probe GL or inspect
private renderer state. The separate Node strip exporter remains Canvas2D.

The backend badge is sampled only after successful draw/frame calls. Fresh mesh
rasterization names its observed backend; cached-only rasters are labeled reused
without inventing a fresh backend submission. A no-mesh DOM draw does not claim
GL. Load/draw failure clears current success. Zoom/fit changes CSS and backing
ratio settings without claiming another render; no independent compare draw is
added, because prepared player time may differ from the last visible pose.

Comparison records independent A/B badges after both draws succeed, including
late and unknown-timing completed pairs. These draws report current renderer
telemetry even when their timing makes feedback unavailable. A fatal partial
pair failure invalidates both current badges and stops app transport; it does not
promise in-place recovery from a renderer error. Recoverable late/unknown timing
or reference-selection mismatch can recover through paused inspection. Pending
inspection qualifies the previous draw without claiming a new submission.
Badges do not change feedback eligibility, clocks, source identities or any
model/motion data. Runtime history records upgrades without migrating approval.

Browser GL/fallback pixels still require separately authorized app-level
validation. Pure status controls and no-mesh public-player controls cover the
adapter boundary only; they do not prove native GL execution or visual quality.
The separate #24 timing evidence describes its original forced-Canvas2D setup,
CPU submission rather than compositor acknowledgement, and its stated host.
Changing to the default mesh backend does not turn those measurements into a
WebGL benchmark or a user-Mac performance claim.

## Opt-in current-page inspection control

`open ... --control` starts a distinct fixed-binding worker with an ephemeral
control capability. A normal `open`/foreground instance does not expose control.
The capability is random, separate from the public source hash, handoff key and
open-status nonce, and stored only in the private0600 worker record outside all
input packages. It is not printed, embedded in URLs, exported with feedback or
returned by the control status response. Reuse still requires exact canonical
inputs, tool fingerprint, source hash and startup animation. Existing family or
unrelated processes are never replaced or stopped by a control request.

`control <input> [--reference <video>] [--compare <input>] [--animation <name>]`
queries only an already running matching opt-in worker. It reports mode,
instanceKey, sourceHash and each live page's pageId/revision/actual inspection.
No page is chosen by latest activity; commands need an explicit page when more
than one is connected. Reads include current theme, automatic/effective layout,
synchronized or independent per-pane cameras, animation/time, playback and repeat,
layers, readiness/feedback eligibility and supported capabilities. Unavailable
capabilities stay false; absence does not manufacture a model or frame clock.
`control.loop` uses `'idle' | 'off'`. In Animate, `'idle'` means the selected
clip repeats. Comparison retains its idle-loop behavior.

`inspection.view`, when supplied, is a closed `rig-review-view/1` observation:

```json
{"schema":"rig-review-view/1","cameras":{"rig":null,"a":null,"b":null,"reference":null}}
```

A measured camera replaces null with
`{space,center:{x,y},zoom,viewport:{width,height},visible:{x,y,width,height}}`.
The `rig`, `a` and `b` entries use `space:"world"` (Y up); `reference` uses
`space:"image"` (Y down). Single view uses rig; compare uses distinct A/B entries
with their actual panel dimensions and independent cameras. Optional
`cameraSync:boolean` and `activeCamera:"rig"|"a"|"b"|"reference"` fields belong
inside this canonical view. Current pages report both; older observations without
them remain readable. `inspection.cameras` still requires legacy CSS `rig` and
`reference` entries, and may additionally report `a` and `b`; compare `rig` aliases
A for readback. Canonical per-pane view coordinates describe the actual cameras. Viewport dimensions
are positive CSS pixels up to65536, zoom is0.25..8, coordinates are finite within
the safe-number range and visible extents are positive. Missing measurements
are null, never invented zero-size panels. The optional observation is additive
to the existing inspection protocol and does not add a source-switch or write
command. Saved canonical coordinates and actual panel geometry must not be
confused with the viewport-specific CSS pan accepted by a camera command.

The command envelope is closed:

```json
{"schema":"rig-review-control-command/1","requestId":"theme-1","pageId":"<registered-page>","instanceKey":"<exact-worker-key>","sourceHash":"<exact-loaded-hash>","expectedRevision":0,"command":{"type":"theme","value":"light"}}
```

Supported commands are `theme` with `system|dark|light`, `layout` with `auto`,
`camera` with target `rig|a|b|reference`, zoom0.25..8 and finite pan{x,y} within
±65536 viewport CSS pixels, `fit` with that target,
`camera-sync` with boolean `value`, `playback` with `play|pause`,
`animation` with an actual single model name, `time` with nonnegative finite
seconds, and `layers` with boolean images/meshes/bones. Targets A/B are valid
only in comparison and require the actual pane. A page without a reported
`view.cameraSync` refuses a sync command rather than inventing support.

Fresh inspections start with camera sync on. Sync copies zoom relative to each
pane's fit and CSS pan divided by that pane's viewport width/height to all visible
measurable panes, including reference, single rig or compare A/B. It does not
infer content alignment between image and world coordinates. Sync off preserves
all current views and subsequent camera/fit operations affect only the target.
Turning sync on aligns visible panes to the last active pane, deterministically
rig in single or A in compare before any pane is active. A legacy compare
`target:"rig"` command is an explicit A/B-group operation even when sync is off;
when sync is on its effect also propagates to reference. Names and actual time/domain checks
are performed by the same normal UI adapters. Invalid compare animation changes
require a new binding and are refused. No requested time is claimed displayed
before existing media/player completion. Compare retains its actual reference
PTS and fixed-step pair path; no independent animation clock is introduced.
A single-video time request commits the actual decoded timestamp to both rig and
inspection state, reporting requested versus actual time when they differ. A
failed or out-of-domain decode attempts to recover the prior actual inspection;
a superseding local action is never undone. This does not promise an exact
arbitrary requested video time or infer a video frame rate.

Local UI gestures, live view-link/history navigation and remote applied commands
advance the page revision. Captured navigation supersedes an in-flight remote
action before the view restore handler runs. A
command carries the exact expected revision; a stale one cannot overwrite a
newer local inspection. The browser helper registers, polls and acknowledges
through fixed `/api/control/register`, `/api/control/poll`, `/api/control/ack`
and `/api/control/close` endpoints using a separate page capability. Its poll
reads the same actual inspection state as the widgets, not a second simulated
player. User input during an asynchronous remote action aborts/supersedes it;
an already started action is not promised rolled back. Dirty annotations or
unadded form drafts prevent context-changing animation/time/playback commands;
presentation-only camera/theme/layer changes preserve them. Save/export or
bookmarked-view restoration busy states refuse concurrent control.

Agent `GET /api/control`, `POST /api/control/commands` and
`GET /api/control/receipts/<commandId>` require the private Bearer capability.
Mutations additionally require the exact loopback Origin and application/json;
all endpoints reject nonloopback host/path parameters and provide no CORS.
Registration is exact-Origin only and yields its page capability only to that
same-origin response. JSON has a streamed16KiB ceiling and2-second body deadline.
At most4 live pages,8 queued commands per page and64 retained receipts are kept.
Page leases expire after30 seconds; queued commands expire after10 seconds.
Unacknowledged dispatched commands become outcome-unknown on expired/closed
pages, never applied success. Idle polling alone does not keep the worker alive;
existing30-minute idle shutdown remains in effect.

HTTP202/`queued` means accepted for delivery only. A receipt later reports
`dispatched`, `applied`, `rejected`, `failed`, `superseded` or `outcome-unknown`,
with actual observed inspection/revision only after acknowledgment. A repeated
requestId with the identical envelope returns its original receipt; different
content conflicts. CLI command exit0 requires applied; other command outcomes or
bounded wait expiry exit2. Query-only reads exit0 when available. Request waits
are0..30000ms (default10000); transport timeouts return an error, not a blind
success or an automatic command retry.

Source bytes are revalidated on accepted enqueue, dispatch and acknowledgment;
existing session/save/export validation remains independently authoritative.
Input changes refuse and never mutate the loaded source binding, replace a
reference, transfer a prior approval or rewrite feedback. There is no command
for paths, URLs, JS/eval, arbitrary DOM/CSS, disk writes, feedback/status, Submit,
strip export or motion keys. The current-page API is a local inspection adapter,
not a remote editing or publication service. See the CLI examples in README.


## Source-bound inspection links and local drafts

The UI's view link uses `#review=<base64url UTF-8 JSON>` with schema
`rig-review-inspection/1` and a maximum16KiB ASCII fragment. The closed envelope
binds mode, exact sourceHash, ordered rig model hashes (or null when unavailable),
animation/time, named selection, theme/layers and the canonical `ControlView`,
including sync mode, active pane and each independent camera.
The loaded source hash includes the selected explicit reference binding; compare
also binds ordered A/B and the reference/animation. A mismatched binding is
refused. Camera state is world/image center and zoom plus actual viewport and
visible rectangle, not a bookmark of CSS pan offsets. Restoring is paused and
occurs before automatic idle preview or remote page registration. An initial
valid URL view takes precedence over the saved local view. Historical links or
local bookmarks without cameraSync restore with sync off, preserving their
existing reference and rig framing. Fresh inspections default to on. Canonical
camera restoration preserves the saved per-pane views before a subsequent synced
gesture or explicit sync-on action aligns them. Legacy modeling/motion workspace
selection remains accepted without restoring a top-level workspace switch.

These optional fields preserve acceptance of older payloads by the current
parser; strict older binaries may refuse new observations. This is not a
forward-compatibility promise or a new source/review identity.

Browser local storage uses `rig-review-draft/1:<scope>:<sourceHash>`, where the
scope itself carries the source identity (`single:<id>:<sourceHash>`, or compare's
A and B id/hash), plus a written-time index `rig-review-draft-index/1`. Opening
deletes nothing; a write evicts the least-recently-written drafts beyond 32 except
any written within the last 24 hours. A draft has schema
`rig-review-local-draft/1` and a maximum512KiB UTF-8 payload. It contains ordinary
ID/radio form inputs, UI selections, the inspection bookmark and the unsent
feedback/checkpoint/status session. It records the SHA-256 fingerprint of the
original submitted server-session baseline, including updatedAt. That baseline
is checked before restoration: a local draft cannot silently overwrite a newer
server review or borrow its approval. On conflict the original local payload is
available to download; explicit recovery is pending rather than a transferred
approval. Corrupt data is likewise preserved with a warning, and writes remain
blocked until explicit discard. Storage failure is a named UI state, not a save.

A model/source change clears only the prior matching scope's source-bound draft.
The separate global appearance preference remains; source-bound camera,
selection, form and view overrides do not migrate. No restore writes the server,
model, motion or source assets. Capability tokens, worker credentials and arbitrary
paths/commands are not persistence fields. Local browser storage can be cleared
or unavailable and is not a durable backup or an authoritative approval ledger.


## Parts explorer and source-bound selection

Part selection is closed `{side:"single"|"a"|"b",slot:string,mode:"context"|"solo",identity?:{attachment:string|null,skin:string|null,reason:null|"hidden"|"no-attachment"|"timeline-null"|"set-hide",set:string|null,activeSkin:string|null}}` or null for Whole rig. Slot membership is checked against that side's actual model catalog, whose exact byte SHA-256 must equal `reviewedSource.rig.sha256`. The source model remains immutable. The catalog retains explicit slot/bone/setup and skin/attachment declarations; an atlas page does not identify a part. Malformed catalog/hash mismatch refuses rather than substituting a guessed catalog.

`selection.part` is optional in versioned inspection links/drafts; absent legacy values mean Whole rig. Unknown keys, invalid modes/sides and unavailable slot membership refuse before restoration mutation. Single cannot restore an A/B target and compare cannot restore a single target. Existing transactional rollback also restores selection. Restoring explicit view cameras does not auto-fit the selected part; a deliberate local selection or Fit action does. The optional `part` control observation reports this exact actual slot/identity selection, and optional `partGeneration:number|null` names its held runtime generation. These observations add no selection/source-writing/approval command. Generation is rejected inside the persisted target identity.

`context.part` in explicit feedback carries copied observed side/slot/mode, the exact identity tuple, held generation, null reason, drawn kind/page/region/sequence/z, actual mesh counts, active skin (null means no skin set), active set, declared skin/key candidates, conservative world-Y-up bounds and `activeAttachment:{skin,attachment}|null`. Play1.12.0's public `slotIdentity()` supplies attachment key and owning skin, including ambiguous/linked/set-selected cases. Hidden/non-drawn API reasons preserve attachment/owning skin null rather than guessing a catalog key. `reason:null` identifies a resolved attachment; it does not promise visible pixels, geometry or positive fit bounds. `identityUnavailable` is null after a valid public snapshot, including known null reasons; no held snapshot reports `PART_IDENTITY_UNAVAILABLE`. No UV/topology/texture-name match is identity evidence. Named vertex weights and original source alpha remain unavailable; the package supplies no inferred loose-art mapping.

Review copies `posedFrame()` with its explicit (nonenumerable upstream) generation and reads `slotIdentity()` under the same public generation. It respects the default public slot filter rather than requesting an unfiltered frame. Every actual frame row must have its coherent snapshot slot/z and resolved identity, while identity-only rows need not have a visible primitive. Unknown/repeated slots, invalid full z order, invalid key/null reason shape and generation mismatch refuse by name before replacing retained state. Identity checks do not call seek/repose or reset physics.

The live selected slot follows animation changes and each successful draw refreshes its actual identity. Bookmarks/drafts capture the tuple at their explicit inspection time; restoration checks that exact tuple only after restoring animation/time/set and drawing. `PART_IDENTITY_MISMATCH` causes the existing full inspection rollback. Legacy targets lacking identity resolve through a valid current public snapshot or refuse `PART_IDENTITY_UNAVAILABLE`; they do not infer keys. Runtime generation is observation/feedback only and is never persisted as a stable target ID.

The right list orders every slot by the public snapshot's exact held z, including hidden/null slots. Solo filters a copied full held posed frame after clip resolution; it never sets player skin, set, slots, clock or track. Context/Whole preserve full drawing. An amber diagnostic selection box uses conservative world bounds intersected with a normal clip's AABB; inverse clips remain conservative. It is not alpha coverage or an exact clip polygon. Selection/Fit centers those bounds within the established0.25–8× camera limit. SyncON sends the same fit-relative zoom/normalized pan signature to visible panes; OFF affects only the selected side. Missing/nonpositive bounds report `PART_FIT_UNAVAILABLE`. Fitting never reseeks or authors motion.

Selection, links, controls and export never approve a review. Producer-backed optimization must use a separately owned producer returning a new source-bound package revision/hash and provenance; Review does not generate rig, motion or mesh bytes.

## Stage region comments

An optional `feedback[].context.comment` (`rig-review-comment/1`) records required placement `mode` (`setup|animate|compare`), `viewport` (`rig|a|b|reference`), `frame:{index,basis:producer|reference}` or null with the named time-only basis below, exact held `time`, `animation`, selected `sourceHash`, nullable `modelHash`, `referenceHash` and `referenceId`, canonical numeric `camera`, `screen` and `world` rectangles (`x,y,width,height`), nearest-first `slots:[{slot,z}]`, `crop:{path,sha256,png,width,height}`, and the source-bound inspection `bookmark`. A point has zero width/height. World space is Y up for a rig and image pixels Y down for a reference. Screen space is local CSS pixels of that viewport; both rectangles must agree through its recorded camera.

When a frame is available, the row's inclusive interval is that one frame. A decoded-reference basis is explicitly distinct from a producer frame; the existing raw `context.frame` stays null when producer timing is unknown. No video FPS is inferred. The target is the first drawn slot intersecting the marked posed/clipped triangles, or the rig for an empty or reference mark. The normal session source binding, same-origin JSON mutation, capability and 1 MiB body limit apply unchanged. Saves validate the comment source/model binding, viewport side, bounded numeric evidence and PNG signature, dimensions, chunk CRCs, bounded RGB/RGBA scanline decode and exact hash. A changed source follows the existing HTTP 409/restart refusal.

The inline PNG is bounded to 150 KiB (200000 data-URL characters), each dimension at most 1024 pixels (the reader-side limit in the record format); the browser starts capture at up to 768 pixels per dimension and re-renders at a smaller scale when needed until the encoded PNG data URL fits inside the 200000-character limit, keeping `crop.width` and `crop.height` equal to the saved PNG dimensions and the burned-in mark visible at reduced scale. Submission materializes only the digest-derived `comment-crops/<sha256>.png` beneath session state, never a client-chosen path. Existing nonregular or mismatched crop files refuse. CLI feedback exports resolve crop paths for local reading and omit `crop.png` only in the derived report; the submitted session and draft retain the original inline PNG; no HTTP filesystem endpoint is added. The PNG composes the actual computed pane backgrounds and visible layers. A whole live canvas is copied when available; otherwise unambiguous displayed image/canvas rasters are matched by z to the held public frame and copied with their actual transforms, opacity and clips. If that safe raster mapping is unavailable, the published CanvasRenderer uses the held frame and actual backend; an unsupported Canvas2D RGB/dark tint refuses `COMMENT_CAPTURE_UNAVAILABLE`. Images off omits model pixels, and mesh/bone/selection overlays copy the existing displayed overlay canvases. Reference crops retain the displayed media background/letterbox. Unsupported background syntax refuses `COMMENT_BACKGROUND_UNAVAILABLE`. No HTML/foreignObject rasterization or DOM screenshot mechanism is used. These are resampled inspection pixels for agent reading, not pixel-identical measurements or proof of upstream compiler validation.

Marks share the ordinary feedback array, source-bound drafts and submission. List restoration validates the bookmark's loaded source binding before applying frame, per-pane cameras and turn. Existing sessions and no-comment JSON/issue output retain their prior shape. Submitted marks open read-only in the composer and stage list and server saves refuse their edit or deletion (`COMMENT_SUBMITTED`); a new comment starts a new unsent row. No source, model or motion file changes.

Single reference marks validate `referenceId` against the selected bookmark reference and `referenceHash` against the exact file hash the package loader already computed, or the CLI-selected reference binding. `/api/review.referenceHashes` exposes these existing source-bound hashes by declared ID; it adds no asset path or decoder endpoint. Single review exposes no decoded reference index. Without an explicit producer frame at the saved time, rig and reference marks save `frame:null` plus `timeBasis:{schema:"rig-review-time-only/1",basis:"seconds",reason:"frame is unavailable: no explicit producer frame index at this time (COMMENT_FRAME_UNAVAILABLE)"}`. The row frameStart/frameEnd, context.frame and context.interval must all be null, while exact finite nonnegative `time` seconds, animation, target, source/model/reference bindings, turn, camera, region and crop remain validated. This named shape is allowed only on single structured comments; an ordinary null interval, a mixed null/numeric range, a numeric interval falsely claiming a time-only frame, or a time-only claim when a producer frame is available is refused (`COMMENT_TIME_ONLY_INVALID`). A comparison cannot use this exception and retains its existing producer/reference frame basis. JSON and issue exports explicitly say that the frame is unavailable and why; strip export refuses `COMMENT_CLOCK_UNAVAILABLE` instead of coercing null to zero. Seconds, video callback counts and inferred FPS are never called frame indices.

The comment mode is captured once at gesture start; switching mode cancels an unfinished gesture/composer. Single Setup binds `mode:setup` to bookmark `selection.inspector:rig`; Animate binds `mode:animate` to `playback`. Compare always records `mode:compare` with a compare page binding, regardless of its Inspector section. Pins/rectangles require the current mode as well as the captured pose; list restoration applies the captured mode before showing the pin. Missing mode refuses `COMMENT_MODE_MISSING`, an unknown enum refuses `COMMENT_MODE_UNKNOWN`, and a page/viewport/inspector mismatch refuses `COMMENT_MODE_MISMATCH`. Structured comments without mode are deliberately refused rather than guessed; ordinary feedback and legacy text `context.comment` remain unchanged. Derived CLI JSON retains the complete canonical `feedback` array and adds `commentGroups:{schema:"rig-review-comment-groups/1",canonical:"feedback",modes:[{mode,feedbackIds}]}` only when structured comments exist. Each ID resolves to that array's full evidence exactly once. Markdown puts the actual comments under `Comments · setup`, `Comments · animate` or `Comments · compare` headings; ordinary feedback retains its category/target sections. Neither export adds a second persistence system. No-comment JSON and Markdown bytes keep the existing format.

Stage comment capture refuses unrecorded authoring effects, by `COMMENT_UNAPPLIED_PREVIEW` plus tool name: actual idle/dial adjust functions, live physics parameter patches, a pending loaded density-strip model, visible authoring geometry (Chest/Bones/Cuts/Cloth/Mesh), and Idle/Rig fields stage handles. Unapplied form operations alone do not trigger this refusal. The **Comment · C (n)** control displays the reason without disabling the button, so the list still opens read-only and rows still restore while placing and editing are refused by name; active capture is cancelled if a preview begins, and capture/save recheck after asynchronous pause/crop. No preview is automatically cleared/applied or omitted from a crop. Applied scratch builds retain their refusal (`COMMENT_APPLIED_BUILD_UNSUPPORTED`); rebuild/model swaps refuse `COMMENT_SOURCE_BUSY`. Turn pad, world/reference and source inspection remain inspection, not authored previews.

`frame.basis:reference` remains valid comment evidence and is retained in JSON/issue reports, but it is not a producer frame interval. `COMMENT_REFERENCE_STRIP_UNAVAILABLE` refuses its CLI and browser batch strip exports before planning/render, independently of viewport side. No reference→producer time/index mapping occurs. Numeric producer/manual ranges remain unchanged; unavailable time-only ranges still refuse `COMMENT_CLOCK_UNAVAILABLE`.


### Parts pointed evidence

Pre-rig parts saves `rig-review-parts-verdict/4` with pointed `issues` (`rig-review-parts-comment/2`, carrying `parts: [{name, imageHash}]` and item or assembled view geometry) while preserving historical `rig-review-parts-verdict/1`, `rig-review-parts-verdict/2`, `rig-review-parts-verdict/3` and `rig-review-parts-comment/1` records on read (existing verdict/1 records read with no issues, `/2` and `/3` records with only comment-backed flags convert to `/4`, and `/1`..`/3` records with bare flagged part or mesh notes surface as read-only legacy verdicts with `PARTS_VERDICT_LEGACY_FORMAT`). This identity comes from the existing
parts verdict source digest and actual original PNG SHA-256, without a fabricated review
manifest id, revision or compiled model. The rig's `rig-review-comment/1` schema stays closed.
See [the parts contract and validation instruments](PARTS_VIEW.md#pointed-parts-comments).

### Interview-stage project subject

`rig-review open <project-root> --project <project-root> --picks-dir <dir>`
opens an interview-stage Create project before a draft or recorded review
package exists. Both roots must resolve to the same directory. The picks output
is an existing dedicated project-relative directory disjoint from inputs.
No version/draft selector is inferred: demo/build version records and unrelated
derived evidence are allowed, while an actual draft or a non-null
`versions[].review_package` requires its existing explicit package designation.
This form takes exactly one target and no additional inspection options.

The existing joined resolver reads the project, retained option sets and input
hashes. The launcher retains an internal interview subject, not a `ReviewPackage`.
The shared server serves the same `web/index.html` and bounded interview routes;
its internal `/api/review` response contains `subject: "interview"`, project
path/hash, source hash, label and capability flags, with no manifest, model,
reviewed-package identity or package session. The existing modal mounts the
existing interview form. Model APIs refuse `MODEL_UNAVAILABLE`; source drift
refuses `INTERVIEW_OPTIONS_STALE`. Reads do not write sources. The joined dialog and standing record form use one shared list | image | survey
answer builder. There is no interview Note input. Existing saved or historical
notes remain readable as read-only text and are carried unchanged. Joined picks
omit `note` when none exists; the job act retains its required string field.
Historical records, picks/act/verdict schemas and explicit
version/draft joins retain their existing readers and checks.
This opening form does not replace the semantic standing review cycle.

## Stage-1 draft mesh inspection

`GET /api/stage-parts` in single inspections uses the live handoff's original
separated parts when a compatible draft is supplied. Its fixed indexed image
routes use the same binding. The closed `X-Review-Stage-Build` read header is
`inspected` or a 64-hex applied build ID; it is not a path or an execution request.
The managed front forwards it only for these single-inspection read routes.
Without a separated draft, the existing inspected atlas remains read-only and
names direct-correction absence. Compare stays read-only and side-closed.
Region-only handoff drafts retain the separated-parts view and image inspection;
`STAGE_DRAFT_NO_MESH` names unavailable direct correction on a part without a
mesh attachment, in English and Korean. It does not turn inspection into an error.
Opening another chest-capable part rebinds both region rows and landmarks to
that part's config and kept-region seed. Reopening the same part keeps its edits.

The draft response adds `draft:{label,buildId,inspectionSourceHash,mappings,evidence}`
to the existing parts-view response; `mappings` names the exact part,
skin/slot/attachment and mesh counts. It includes no inherited verdict or
submission authority. Raster/crop, float32 UV, triangle and source-hash checks
bind the displayed geometry. `evidence` is the actual applied producer job, not
a guessed correction-export object. A changed original refuses; scratch is never
quietly repinned. Every scratch read revalidates the recorded revision and build.

New `rig-review-applied/1` (Chest regions) and `/3` (Edit Mesh) records add optional
`check` and `stageInputHash`. Chest records also support `files` and `mesh`, as
existing patch/delta records do; `/2` can carry `stageInputHash` too. The input
pin hashes the whole revision plus the present scratch mesh/config/delta/world
inputs; compiled file hashes stay in their existing build record. Producer
remesh checks are reused only when their revision hash rows validate; older
producers run the existing check operation on scratch. A new null, failed or
nonzero-exit mesh check refuses `EDIT_SUBMIT_UNCHECKED`. Historical `/1` and `/3`
without those optional fields stay readable and never gain synthesized checks.
A newly requested Apply does not reuse a historical result lacking check data.
Each settled Apply writes a server-owned, SHA-256-verified evidence seal under
`<state>/applied-evidence/<package hash>/<build id>.json`, bounded to 1 MiB per
build. It holds the exact applied record, package binding, operation, input and
output digests, model hash and check summary. Seals remain for the state directory's
lifetime, independently of the eight-build Undo cache; pending strip candidates
are not applied and receive no seal. Add feedback remains local until Submit.
New made-mesh submissions with an input pin must exactly equal their sealed
record, including after Undo, eviction or a server restart. Missing, damaged or
different evidence refuses `STAGE_DRAFT_STALE`; client fields or `result.json`
alone are never evidence. Historical feedback describes the recorded Apply,
not the currently displayed revision. Stage reads separately re-hash the live
revision and compiled files, require the settled current Apply and successful
check, and retain `STAGE_DRAFT_CHANGED`/pending refusals. A seal never authorizes
drawing an evicted, changed or pending build as current.

Original `sourceHash`, `reviewedSource`, session/draft scope and parts verdict/2
remain unchanged. The scratch parts digest changes with its geometry; original
approvals never become scratch mesh approvals. Reset returns inspection to the
original. Draft geometry is structure evidence only. Correction records are
exported only through the standalone [Correction handoff](#correction-handoff)
(review#422/create#99); no universal export, artwork Apply,
source-key write or automatic message is introduced.


Draft correspondence supports producer-authored named `weights` (compiled
weighted bindings) and authored unweighted `vertices` (compiled `xy`), comparing
the bone names and each represented float32 component exactly. Raw bone-indexed
vertex runs refuse `STAGE_DRAFT_GEOMETRY_UNSUPPORTED`; Review does not infer their
index mapping. This does not restrict standalone parts-mode UV inspection.
Equal UV/index arrays alone are insufficient when compiled vertex data differs.
Single Stage-1 controllers retain selection/camera on same-build navigation;
cross-revision restoration requires the same original package/image/placement
and exact draft skin/slot/attachment address, with named refusal if absent.

### Correction handoff

For the active standing live-job cycle, see [Live job contract](#live-job-contract), [Create #182](https://github.com/rig-c/create/issues/182) and [Create #184](https://github.com/rig-c/create/issues/184). In the active cycle, agents do not build, parse, reshape or carry Review session, picks, verdict or applied-record storage files. `described-correction` and `mesh-edit` remain reserved as standalone act kinds (`JOB_ACT_KIND_DISABLED`). The live mesh handoff uses [Mesh edits on Request changes (act@8)](#mesh-edits-on-request-changes-act8). The file-based `--correction`, `--feedback-file`, reshaped feedback JSON and `--verbatim-file` flow below is retained as legacy/history documentation and is a bypass finding if used in the active cycle.

The existing feedback context may carry `correction: {path, selector}` on a
saved single-package item. The path is `described` or `made`. A selector names
`{stage:"parts-review",kind:"draft",id}`,
`{stage:"rig-review",kind:"rig",version}` or
`{stage:"direction-review",kind:"post",version,modelFile}`. The selector is
explicit handoff data. The package revision and inspector navigation do not
supply it. The named model path is data for Create and is never opened by
Review. Only explicitly marked correction rows can carry multiline text.

For a described request on a package with authored direction, use the
inspected compiled model's relative path as `modelFile` and explicitly select
the Create post number. Review checks the model path against the package and
refuses a described direction request captured on a scratch Apply. A promoted
stage comment keeps its original camera, inspection time and marked screen and
world regions. For unmarked feedback the export carries the saved inspection
view and a null marked region.

Use `rig-review feedback <package> --correction <item-id> --format issue`.
The issue JSON carries the exact human `verbatim`, `selectorArgs` and a
`createSource` string (JSON, at most 32 KiB) with the post number, inspected
model and direction path/hash pairs, package revision and source hash, and
inspection context. To import into Create:

1. With Create at [76a96dc](https://github.com/rig-c/create/commit/76a96dc528e07804a4df5e6c6e99ec5fc66b751c),
   run `rig-create direction check <post> <project> --json`. Compare its
   `post`, `direction` and `document.rig.model` to the matching fields in
   the decoded `createSource`. Stop on any mismatch, including a different
   post that uses the same compiled model.
2. Write the decoded `verbatim` to a UTF-8 file without trimming or appending
   a newline. Run `rig-create correction record <project> --id <item-id>
   --path described --stage direction-review --version <post>
   --model-file <model-path> --by <reviewer> --verbatim-file <words>
   --source <createSource> --json`. Pass the decoded `createSource` string
   as one argument. The writer returns `rig-create/correction@2` with
   `on.model` and `on.direction`, and an open description (`outcome: null`).
   Create retains `source` as opaque text. Review runs no Create command.

For a joined Create project, `--project-version` selects the recorded rig
package and optional `--post-version` selects its authored post. Review checks
the package inventory and derives the exact project-relative path from the
inspected package model inside that inventory. The direction document must
bind this path and its SHA-256. The project's direction stays outside the
package asset routes. The joined session source binds the project digest,
package source, rig version, selected post and direction file. Reopen if any
of these inputs change.

In Review's correction form use the selected post and the inspected
package-relative model path. In the issue export, `selectorArgs` and
`createSource.model` use the original Create project-relative model path.
`createSource.inspectedModel` retains the package-relative binding. Use the
same joined arguments on the feedback command to retrieve the joined session.

Packages without authored direction continue to use their explicit legacy
selector. Direction patch Apply is unavailable. Existing supported rig and
draft Apply records keep their producer and result evidence.

When `--project` and `--project-draft` select a recorded draft whose project entry declares `config`, `parts`, `rig` and `check` directories, `/api/rebuild` exposes `draft` metadata with the recorded draft id, producer provenance (`draft.producer`) and input paths alongside the resolved installed `producer` and `compiler` without synthesizing a package `reviewedSource.handoff`. Rebuild status resolves the installed producer and compiler via `resolveProducer` and its operation-capability floors (`REMESH_SINCE` for `remesh --mesh`, `REMESH_DELTA_SINCE` for `remesh --delta`, and `EDIT_PRODUCER_MISMATCH` when a config patch's `producer` differs from the installed producer), without an equality version gate against `draft.producer`. While the draft is editable (`project.stage` in `parts` or `parts-review` without an effective `parts-review` sign-off, and not `--view-only`), `/api/rebuild` accepts region rebuilds, `remesh` config patches and mesh deltas in scratch, and refuses whole-rig, retarget and animation operations with `STAGE_DRAFT_OPERATION`. When the draft is not editable or `--view-only` is set, `/api/rebuild` and `/api/stage-parts` report the draft as inspection-only (`PARTS_VERDICT_READ_ONLY: Stage 1 draft is inspection-only` and `draft.inspectionOnly: true`) and refuse rebuild mutations and scratch Stage 1 build reads (`STAGE_DRAFT_UNAVAILABLE`). Separately, saving or exporting the Stage 1 parts verdict requires an editable draft, `--parts-verdict-dir`, no `--view-only`, and the `inspected` build (`PARTS_VERDICT_READ_ONLY` otherwise).

A supported made item must match the server-owned settled Apply seal and
retained scratch model and pages when the item is added or changed and on
selected export. Older unchanged items remain saved as historical evidence
when a newer Apply or eviction changes the retained scratch builds. A fresh
selected export still requires its retained result. The check
must pass with exit zero, a passing gate and at least one PASS bar. Known
SKIP, WARN, CLEAR, REPORTED and UNCLASSIFIED values and the producer line are
retained as reported. Missing evidence and failed checks cannot become checked
claims. A described request and a preserved unsupported operation do not
assert a result. Selected JSON export is the exact current session file.

When a producer config names a requirements file, Review includes the original
file's path and byte hash in the handoff. Apply copies those bytes into its
private scratch directory and points the scratch config at that copy. The
copied input is checked with the retained result. A missing or redirected
requirements file refuses the handoff or Apply by name.

### Direction inspection

A single-package inspection with authored direction shows a collapsed Direction
panel above the stage. The panel names the current model and its SHA-256, the
package revision and source SHA-256, and the installed Play version. It reports
the compiled sliders available through the Turn Pad and the attachment sets
loaded through Play. Independent depth control is unavailable on this surface.

A manifest may declare `direction` as the literal package-relative path to a
retained Create `rig-create/direction@1` or `rig-create/direction@2` document
(up to 256 KiB). A manifest may also declare `scene`, requiring `direction`.
The scene must equal the direction@2 path, hash and number and be a closed
`rig-create/scene@1` document. Its rig/model and stage match the inspected model;
its animation must exist. Background and optional foreground PNGs are contained,
byte-hashed, dimension-checked and served with the scene. The closed layer order
is background, rig, then the declared foreground. Missing, changed or mismatched
inputs refuse by name (`SCENE_REQUIRED`, `SCENE_SOURCE_MISMATCH`,
`SCENE_MODEL_MISMATCH`, `SCENE_ANIMATION_MISSING`, `SCENE_PLATE_CHANGED`,
`SCENE_PLATE_DIMENSIONS`, `SCENE_LAYER_ORDER`).

Scene playback uses the shared viewport and its existing canvas, controls and
point comments. The take clock follows duration/loop, the camera box frames the
composite, and timing maps take seconds to rig-animation seconds. The panel names
the take and its planes without JSON. Direction@1 and scene-less publications
retain the plain rig view with a reason. Scene and plate bytes enter the existing
package/publication source hash; verdict acts gain no fields. Live post summaries
use the publication's existing post selector for their version.
Preserve the document's model path relative to the Review package root. Review
requires that path and SHA-256 to match the inspected compiled model and
includes the direction file in the package source hash. The panel shows authored
take and planes read-only while that inspected model is on stage. Create
remains responsible for validating project history and citations. Viewport pan
and zoom affect only inspection. Camera Apply remains unavailable; authored
camera playback requires the declared scene above.

The optional `sets` manifest path names a package-local Play attachment-set
sidecar for the inspected single-package build. Review includes it in the
source hash and loads its sets through the published runtime. Scratch builds
use their own model and do not inherit the inspected build's sidecar. Compare
and standalone parts retain their existing inspection surfaces.

The standing live-job contract ([Review #484](https://github.com/rig-c/review/issues/484)) retains `source.direction` and the `direction-review` verdict stage unchanged. [Review #797](https://github.com/rig-c/review/issues/797) wires plated take playback through the shared viewport and publication identity, superseding the playback core of #482/#483. [Review #373](https://github.com/rig-c/review/issues/373) closed as not planned: the direction review covers authored camera work, and `CAMERA_APPLY_UNSUPPORTED` stays the refusal.

### Scene interview records

The interview reader supports the scene option codec and dated currentness in
Create's merged [PROJECT contract](https://github.com/rig-c/create/blob/f1868eeeed2dcc6b792c230a8bf93117a05edcd5/docs/PROJECT.md#scene-option-context).
It checks every historical answer and completed decision at its own time and
retains original words, source, time and set bindings with named record issues.
Pre-cutoff currentness-only exceptions display `INTERVIEW_OPTIONS_SCENE_LEGACY`
without blocking the legacy interview. Full scene image and registration checks
remain producer checks.

A `scenes[]` entry's `by` is the literal `agent` or a human name, and the rig
signoff comparison still establishes the human acceptance the scene rests on.

[Review #555](https://github.com/rig-c/review/issues/555) carries scene
interview history and legacy warnings through standing job publications under
`JobPublication.interview` (`rig-review/job-interview@1`, `null` for non-Create
packages) across `publish`, `next`, `readPublication` and the retained
`/jobs/<jobId>/publications/<publicationId>/instances/<instanceKey>/api/interview`
route. Every inspected `pending_options` row, choice-bound `answer`/`guide`/`history[i]`
row and completed `answer.agent_decision` row is recorded in `interview.records`
with its own evaluation timestamp (`evaluatedAt` for inspection rows, `answer.at`
for answer rows, `decision.at` for completed decisions, and `at: null` with no
currentness evaluation for covers-only decisions) and joined 1:1 by `(record, at)`
to `interview.diagnostics` (`INTERVIEW_OPTIONS_STALE` error or
`INTERVIEW_OPTIONS_SCENE_LEGACY` warning). Active editable option sets that fail
currentness or codec checks still refuse standing publication with
`JOB_RECORD_INCOMPLETE` before publication lookup or snapshot writes. Browser
and unit probes over `tests/fixtures/scene-interview-551` alter the committed
writer archives into explicit synthetic controls
(`SYNTHETIC_CONTROL_OVER_WRITER_ARCHIVE`); committed writer archive provenance
does not make an altered project a real-user scene (`REAL_USER_SCENE_PENDING`)
or establish official Create writer acceptance.

## Live job contract

`src/job-contract.ts` defines the frozen semantic contract boundary for [Review #484](https://github.com/rig-c/review/issues/484), [Create #182](https://github.com/rig-c/create/issues/182), [Create #184](https://github.com/rig-c/create/issues/184), [Parts #1159](https://github.com/rig-c/parts/issues/1159) and [Parts #1163](https://github.com/rig-c/parts/issues/1163) under `JOB_API_SCHEMA` (`rig-review/job-api@2`) and `JOB_ACT_SCHEMA` (`rig-review/act@2`), implemented across the backend session/store (`src/job-store.ts`, `src/job-session.ts`, `src/job-source.ts`, `src/job-act.ts`, `src/job-api.ts`, `src/job-worker.ts`), standing loopback job front and browser window runtime (`src/job-front.ts`, `web/job-session.ts`), and `rig-review session` CLI (`src/entry.ts`, `src/job-cli.ts`). The public installed managed-host entry is `@rig-c/review/job-host` with frozen exports in [Public API stability](STABILITY.md#managed-owner-host). Create supplies the publication reader and private writer binding for committed rig versions and direction posts, and its writer uses that binding for `fetch-act` readback. Publishing a Create package from a root containing `project.json` without a host `readPublished` callback refuses `JOB_SOURCE_UNRETAINABLE` with `CREATE_PUBLICATION_CONTRACT_UNAVAILABLE`. One-shot file-handoff workflows documented elsewhere in this reference remain preserved as legacy/history compatibility for existing callers.

### Vocabulary, authority, CLI and host ports

- **Human UI vs agent verbs.** People submit decisions exclusively through the Review browser UI (`actor` set to `'human'`, `channel` set to `'review-ui'`). Agents drive the standing job through four semantic verbs (`publish`, `ask`, `next`, `close` in `JobAgentRequest`). Consumer writers use the separate read-only transport verb `fetch-act` (`JobFetchActRequest`), which is never a human-act writer.
- **Exact `rig-review session` CLI surface.** `src/entry.ts` and `src/job-cli.ts` implement:
  - `rig-review session open <root>` (requires `RIG_REVIEW_JOB_REVIEWER_ID` and `RIG_REVIEW_JOB_REVIEWER_ROLE` as `owner` or `delegate`; optional `RIG_REVIEW_JOB_PORT` `0..65535`; optional `RIG_REVIEW_JOB_AGENT_FD` `>= 3` receiving one `{jobId, origin, agentCapability}` JSON line before printing `ownerUrl` on stdout).
  - `rig-review session publish <job-url> --generation <n> --key <id> --result <relative-path> --freeze-hold <id> [--selector <JSON>] [--record <path> --record-hash <sha256>] [--request-id <id>]`
  - `rig-review session ask <job-url> --generation <n> --key <id> --publication <id> --subject <JSON> [--request-id <id>]`
  - `rig-review session next <job-url> [--after <cursor>] [--wait-ms <n>] [--request-id <id>]`
  - `rig-review session close <job-url> --generation <n> --key <id> --reason <words> [--request-id <id>]`
  - Consumer only, `rig-review session fetch-act <job-url> --act <actId> --consumer-capability-stdin [--still-out <existing-directory>]`. The trusted consumer pipes its existing grant on stdin. New rig acts require `--still-out`.
  Agent verbs authenticate with `RIG_REVIEW_JOB_AGENT_CAPABILITY` (`Authorization: Bearer …`) against `http://127.0.0.1:<port>/jobs/<jobId>` and refuse `fetch-act` (`JOB_AUTHORITY_REFUSED`). See [Standing live job workflow](WORKFLOWS.md#standing-live-job-workflow) for an ordinary-package launch, bootstrap and explicit close example.
- **Bootstrap-declared reviewer.** `JobReviewerBinding` (`id` and `role` as `'owner'` or `'delegate'` inside `JobHumanAuthority`) is declared by trusted host bootstrap when opening the window. The browser UI cannot type, edit or override this binding. It records bootstrap-declared provenance rather than keyboard-user authentication. Create maps `role` to its existing `by` authority and preserves the declared reviewer identity.
- **Trusted host ports and public managed-host startup seam.** `JobHostPorts` separates `handleJobApi` (which accepts agent verbs and consumer `fetch-act` only) from closed same-origin UI routes (`readPublication`, `commitUIAct`, `ackDisplayed`, `jobLiveness`, `subscribeJob`, mounted by `createJobFront` under `/jobs/<jobId>/…` with sealed retained publication routes; the standalone owner HTML root accepts the default or literal `?lang=en` or `?lang=ko` only) that remain unavailable to agent tokens. Raw `Request` objects preserve real `Origin`, capability, body size and abort context. A TypeScript value is never authentication evidence. In the public managed-host startup seam (`startJobHost(options: JobHostOptions): Promise<JobOwnerHost>` from `@rig-c/review/job-host`, where `JobHostOptions extends JobWorkerOptions` adds `readerId?: string`, `bindingId?: string`, `partsEnumeratorId?: string` and `reuseOnly?: {readonly expected: JobHostReuseExpectation}`, and `JobOwnerHost` includes `attachment: JobHostReuseExpectation | null`, frozen in [Public API stability](STABILITY.md#managed-owner-host)), each present hook (`readPublished`, `installWriterBinding`, `partsEnumerator`) requires a nonempty declared ID and a missing hook requires its ID to be absent (`JOB_HOST_OPTION_ID_INVALID`). Equal declared IDs, API/act schemas and actual enumerator versions permit authenticated active-listener reuse across processes and newly allocated function objects via `/jobs/<jobId>/host` (`schema: 'rig-review-job-host/1'`). Differing IDs, hook presence differences and unrecorded older listener IDs fail by name (`JOB_HOST_REUSE_MISMATCH`) with the option name and both IDs while preserving the existing listener. No function hashes are used. `installWriterBinding` receives `{jobId, origin, fetchCapability}` after reuse validation and runs on a matching new or ordinary reused host.

  `@rig-c/review/job-host` exports `JobHostListenerIncarnation`, `JobHostReuseBinding`, `JobHostReuseExpectation`, `JobHostAttachField` and `JobHostAttachFailure` as types while preserving the twelve runtime exports. Each standalone or hub listener start mints a fresh canonical lowercase UUIDv4 `listenerIncarnation` (`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`) via `randomUUID()` that rotates on listener stop and restart. `GET /jobs/<jobId>/host` retains its exact legacy `JobHostRecord` projection, key order and raw bytes without `listenerIncarnation` or `attachment`. Complete live binding attestation uses the internal authenticated `POST /jobs/<jobId>/host` route (`X-Review-Capability` UI grant and exact normalized `Origin`, with no public helper export) exchanging `{expected, observed: {root, stateDir, store, record}}` (safe nonnegative `{dev, ino}` integers for `root`, `stateDir`, `jobs.sqlite` and `job-ui/<jobId>.json`) for `{ok: true, attachment, pid}`. Each `job-ui/<jobId>.json` descriptor, each `POST /jobs/<jobId>/host` request and each `POST /jobs/<jobId>/host` response has a 65,536-byte (`WORKSPACE_BODY_LIMIT`) ceiling. When adding `listenerIncarnation` would exceed 65,536 bytes, `job-ui/<jobId>.json` omits `listenerIncarnation` so ordinary start and reuse still succeed with `attachment: null` while strict `reuseOnly` refuses `JOB_HOST_ATTACH_REFUSED` with `reason: 'incarnation-missing'` and `phase: 'record'`. Opaque hook IDs and fingerprints are bounded by each 65,536-byte descriptor, request and response envelope without separate 1,024-byte or 4,096-byte field caps.

  `startJobHost` inspects the `reuseOnly` property descriptor before invoking getters, rejecting a `reuseOnly` getter or accessor immediately with `JOB_REQUEST_INVALID` without invoking the getter. When `reuseOnly` is absent or `undefined`, `startJobHost` uses the ordinary `{...options}` startup path and preserves existing ordinary getter, prototype and callback behavior. When `reuseOnly: {expected}` is provided, `startJobHost` snapshots own data properties (including non-enumerable declared fields) of `options`, `reviewer`, `partsEnumerator` and `reuseOnly.expected` (`binding` and `binding.reviewer`) via `Reflect.ownKeys` and property descriptors before the first `await` or session allocation, retaining callbacks by reference and rejecting non-plain objects, symbol keys, unknown keys, or getters and accessors with `JOB_REQUEST_INVALID` without invoking getters. Strict `reuseOnly: {expected}` bootstrap invokes zero callbacks and performs zero allocations or writes, leaving an empty bootstrap write set on both success and refusal. It resolves existing `stateDir` without creating directories, refuses symlinks, hardlinks and SQLite `-wal`, `-shm` or `-journal` sidecars without recovery, inspects existing `jobs.sqlite` in read-only mode without creating files (`SQLITE_OPEN_READONLY | SQLITE_OPEN_NOFOLLOW`, `PRAGMA query_only=ON`), and stages `JobSession.openReadOnly` before the single final `POST /jobs/<jobId>/host` probe (refusing drift after staging with `JOB_HOST_ATTACH_REFUSED`, `reason: 'race'` and `phase: 'adoption'`). It preserves literal `http://127.0.0.1:<decimal-port>` in `origin` (`1..65535`, including explicit port 80 while comparing `Origin` against normalized `new URL(origin).origin`), enforces a 1,500 ms client total deadline and `redirect: 'error'` alongside a 10,000 ms server body deadline, and orders owner acceptance inside a synchronous deferred SQLite read transaction against `sealClose` (`BEGIN IMMEDIATE`, HTTP 409 with `reason: 'closed'` and `phase: 'acceptance'`) and stop flags (HTTP 503 with `reason: 'stopped'` and `phase: 'acceptance'`). Later semantic writes lazily reopen the same existing `jobs.sqlite` file with `SQLITE_OPEN_READWRITE | SQLITE_OPEN_NOFOLLOW`. `JobHostAttachFailure` is the closed union of `{code: 'JOB_HOST_ATTACH_REFUSED', reason, phase}` (`reason` in `'missing' | 'closed' | 'incarnation-missing' | 'replaced' | 'read' | 'probe' | 'stopped' | 'race'` and `phase` in `'input' | 'state' | 'record' | 'probe' | 'adoption' | 'acceptance'`) and `{code: 'JOB_HOST_REUSE_MISMATCH', field, expected, actual}` (`field` as `JobHostAttachField`, `expected` and `actual` as `string | null`).
- **Standing window and visual gate.** Every owner visual, question, choice, correction and verdict goes through one standing Review window/link plus one what-to-look-at line (a job survives zero open owner tabs and reuses the same active job/link on later `session open` until explicit `close`). Internal agent and HQ media stay internal. Each `JobPublication` reports `visual` with `status` set to `'available'` or `'unavailable'` with a named `code`. A missing required visual is an immediate stop plus a Create-filed on-path Review card, never a chat fallback.

### Owner submit refusals

For each refused `POST /jobs/<jobId>/ui/acts` that reaches the managed listener's
owner route, the listener writes one JSON line to stdout by default. The record
contains the HTTP refusal's `code`, the fixed `route` template
`/jobs/:jobId/ui/acts`, and `bytes`, the count read by the existing body reader.
`bytes` is zero when a gate refuses before reading and can be a partial count
when reading stops early. The listener uses the observed stream count, regardless
of the request's `Content-Length`. For refusals at a byte bound, `limit` gives
the applicable ceiling. A capture or event limit can apply to a derived value,
while `bytes` always counts request bytes. The record carries no request body,
headers, capability, raw URL or refusal message.

The listener uses the supplied `onRefusal` callback in place of the stdout
line. Successful submissions and replays, display acknowledgments and agent
requests emit no refusal record. HTTP responses and existing startup output
retain their formats. See [Managed owner host](STABILITY.md#managed-owner-host).

### Publication, producer-held freeze and generation CAS

- **Mutating requests and CAS.** Agent mutations (`publish`, `ask`, `close` in `JobMutation`) require `expectedGeneration` (a nonnegative safe integer) and `idempotencyKey` alongside `schema` (`rig-review/job-api@2`), `jobId` and `requestId`. Stale generations refuse with `JOB_GENERATION_STALE` and conflicting idempotency payloads refuse with `JOB_IDEMPOTENCY_CONFLICT`. A repeated `idempotencyKey` with the same payload returns the stored result only while that result is still true ([Review #1022](https://github.com/rig-c/review/issues/1022)): a replayed `publish` whose publication is no longer the head refuses `JOB_ACT_SOURCE_STALE`, and a replayed `ask` whose ask is no longer pending and has no finalized act refuses `JOB_ASK_SUPERSEDED` (`JOB_CLOSED` once the job is closed). Each refusal message names the replayed identity and the current head (`publication <id> is superseded; head <id>`, `ask <id> is superseded; head <id>`). A replay of a still-head publication, a still-pending ask or an ask whose act was finalized returns its stored result unchanged, and a `close` replay is unchanged. When `handleJobApi` (`POST /jobs/<jobId>/api`) catches a thrown refusal, the failure envelope `generation: number` reports `session.lastObservedGeneration`, which is the last durable generation this session observed successfully in storage and is carried in memory without rereading failing storage inside `catch`. That value reports the last observed session generation while preserving the original named refusal code and message (such as `JOB_STORAGE_FAILED` when SQLite files are removed or replaced) and keeping the numeric `generation: number` response type unchanged. A failed session constructor exposes no API ports when its initial storage read fails. Success responses continue to report current `session.status().generation`.
- **Explicit producer-held freeze.** `JobPublishRequest` designates a root-relative `result` (`path` and nullable `selector`, never a command) and requires `freeze` with `kind` set to `'producer-held'`, `holdId` and `record` (`JobFileIdentity` for the exact record used for selection, or `null` for a declared non-Create root) held until acknowledgment. Review validates retained bytes, detects a moved or incomplete record (`JOB_FREEZE_REQUIRED`, `JOB_RECORD_INCOMPLETE`, `JOB_RECORD_MOVED`, `JOB_SOURCE_MISMATCH`, `JOB_SOURCE_UNRETAINABLE`, `JOB_ROOT_REPLACED`) and commits local CAS. The freeze assertion is a caller obligation on the publishing producer or agent, not a lock Review can impose on independent writers.
- **Managed-state privacy boundary.** Managed state stays behind the host ports. The canonical work root and configured managed-state directory must be disjoint. A root equal to, inside or containing that state directory refuses `JOB_SOURCE_UNRETAINABLE` before job admission, including directory aliases resolved through symlink ancestors. Existing root identity failures, including a directly symlinked source root, retain `JOB_ROOT_REPLACED`. Trusted publication handles follow the origin job's lifetime, and publishing callers must maintain their producer-held freeze.
- **Explicit close lifecycle.** Review offers no watched-root or automatic-close guarantee. Only an explicit `close` request (`JobCloseRequest` with `reason`) ends an active job (`status` transitions from `'active'` to `'closed'`, and subsequent mutations or fetches refuse with `JOB_CLOSED`).
- **Snapshot preservation lifecycle.** Every open-job publication, pending ask, page and trusted publication handle pins its snapshot. Explicit close invalidates pending asks, pages and trusted handles, whose subsequent operations refuse `JOB_CLOSED`. Every finalized act permanently preserves its bound source bytes, hashes and retained reproduction evidence. Unfinalized snapshots become reclaimable only after close and explicitly counted asynchronous file reads have finished or cancelled. Event/replay/previous-publication identities remain readable without pinning bytes. No age-based deletion or consumer retain/release API exists. Reclaimed snapshots retain an immutable private publication ID, snapshot hash, reclamation time and `closed` or `superseded` reason, and references reaching the reclaimed-snapshot gate refuse `JOB_SNAPSHOT_RECLAIMED`. The private hash is SHA-256 of UTF-8 `JSON.stringify(orderedSeals.map(({path,sha256}) => ({path,sha256})))`, retaining order, strings and fixed keys. Existing public source-hash formulas remain the source binding. Close and capability revocation use additive durable records outside the bounded JSON document so they succeed at its exact 16 MiB boundary while preserving historical document/replay bytes. Unknown legacy ownership and interrupted-reader counts preserve bytes until ownership or explicit completion is proved. See [Public API stability](STABILITY.md#managed-owner-host).
- **Finalized acts and cursor replay.** `JobNextRequest` (`verb` set to `'next'`, `after` cursor or `null`, and daemon-bounded `waitMs`) and `subscribeJob` replay complete durable `JobEvent` items (`published`, `pending`, `act`, `closed`) in order, returning `JobNextValue` (`events`, `cursor`, and `status` as `'events'`, `'timeout'` or `'closed'`). Waiting is abortable and never consumes an act. Invalid cursors refuse with `JOB_CURSOR_INVALID`.

### Exact displayed source and local draft retention

- **Daemon-derived source binding.** The original model branch of `JobSourceBinding` requires non-null `sourceHash` (`JobSha256`) and `package` (`id` and `revision`), and requires explicit values or explicit `null` for its typed nullable fields (`projectHash`, `selector` as `draft` / `rig` / `post`, `model`, `direction`, `optionSet`, `appliedResult`, `plan`, `parts`). Original input paths are literal project-relative or package-relative provenance only, and no public field names a Review state directory or stored document. The daemon derives `JobSourceBinding` from validated retained bytes and the actual displayed publication. Clients never provide trusted source hashes or transfer prior approval onto a new binding.
- **Display receipt and UI submission.** `JobDisplayPublication` pins same-origin `routes` (`entry`, `apiBase`, `assetsBase`) to that specific `publicationId` and `instanceKey` without a mutable current alias. All metadata, images, runtime assets, routes and pending form dependencies prepare before the visible swap; paint and the single `displayedNonce` acknowledgment precede retirement of the previous view, and failed preparation or acknowledgment restores the prior view and draft. After `ackDisplayed` validates `JobDisplayAcknowledgment` (`publicationId`, `pageId`, `sourceHash`), it returns `JobDisplayReceipt` containing the page-scoped `displayedNonce` secret (never returned by the agent or consumer API). `JobUISubmission` supplies `publicationId`, `askId`, `pageId`, `displayedNonce`, `expectedGeneration`, `submissionId`, `kind` and `value` (`JobUIActValues`). Neither `authority` nor `source` is accepted from the browser. The daemon derives both from the validated nonce and displayed publication (`JOB_DISPLAY_MISMATCH`, `JOB_ACT_SOURCE_STALE`). Retrying the same `submissionId` returns the same immutable `JobAct`, while a changed payload refuses.
- **Pinned package input recheck.** Each applicable pinned package request rechecks the full package byte binding against the publication, with no stale-response window. A removed or changed bound member, a symlink swap outside the valid package path, or a member recreated with different bytes refuses on the very next applicable request with HTTP 409 `JOB_SOURCE_MISMATCH`. Restoring identical bytes at a valid path resumes successful reads, including when the regular file was recreated.
- **Cache policy ([Review #1050](https://github.com/rig-c/review/issues/1050)).** Publication JSON, `api/*` JSON, the event stream, acts and every refusal stay `Cache-Control: no-store`. A sealed snapshot file under a publication's instance route is `private, max-age=31536000, immutable` with its seal SHA-256 as `ETag`: each publish mints a new `publicationId`, so one URL names one content, and the no-store `api/review` read that starts every page load still runs the full package recheck above. The shipped `index.html`, `main.js` and `styles.css` keep one URL across Review installs, so they are `no-cache` with a content `ETag` and revalidate through the job liveness check on every load. In one page load each resource is requested once: `/api/review` once per preparation, and the compiled model once for Play, the part catalog and the physics document together.
- **Old drafts retained and flagged without rebinding.** When a new publication updates or replaces the displayed source, older local drafts remain retained in storage under their original source binding and are flagged without rebinding or transferring onto the new publication.

### Act kinds, plan identity and parts identity

- **Five enabled kinds and two reserved disabled kinds.** `JOB_ENABLED_ACT_KINDS` enables `'interview-picks'`, `'checkpoint'`, `'parts-verdict'`, `'review-verdict'` and `'signoff'`. `JOB_RESERVED_ACT_KINDS` reserves `'described-correction'` and `'mesh-edit'`. Asks and standalone acts of either kind refuse `JOB_ACT_KIND_DISABLED`. `described-correction` awaits the joint [Create #182](https://github.com/rig-c/create/issues/182) context allowlist. The jointly signed mesh value rides on the rig-review verdict under [Mesh edits on Request changes (act@8)](#mesh-edits-on-request-changes-act8).
- **`interview-picks`.** Fresh package and record answers use `rig-review/act@6`. They carry `questionId`, ordered `selections` (`itemId`, `optionId`, nullable `otherText`), `note` and ordered `comments`, with non-null `source.optionSet` (`id` and `sha256`). The note and Other text remain survey answers. Historical act@2 and act@4 picks keep their readers, including the optional act@4 `words` added by [Review #1048](https://github.com/rig-c/review/issues/1048).
- **`checkpoint`.** `JobActValues['checkpoint']` carries `checkpointId`, `planStepId`, `outcome` restricted to `'pass'` or `'fail'` and required `words` as a `string`. `pending` stays in the UI draft only and never produces a finalized act. Only `'pass'` is eligible for Create's checkpoint sign-off writer, whereas `'fail'` is feedback or a named consumer refusal and never an approval write. `words` is preserved verbatim including empty or whitespace-only strings, matching Create's writer without adding a UI gate. In `JobSubject`, `checkpointId` defaults to the Create plan step ID and optional `planStepId` is required when the displayed Review checkpoint ID differs, matching [Create #184](https://github.com/rig-c/create/issues/184) without alias inference or browser trust. The browser supplies `checkpointId`, `outcome` and `words` only (`JobUIActValues['checkpoint']`), the daemon copies resolved `planStepId` from the validated ask and requires `source.plan`, and Create derives execution stage from its authoritative step phase and order without Review stamping a stage.
- **`parts-verdict`.** `JobActValues['parts-verdict']` is `PartsVerdictValue` (`verdict` as `'approved'` or `'changes-requested'`, `issues` as `readonly PartsIssue[]` under `rig-review-parts-comment/2` — empty on `'approved'` and non-empty on `'changes-requested'`, bound to `source.sourceHash`, retained `partIds`, and `source.parts.images` hashes — and `words`), emitted in new finalized `rig-review/act@5` acts (`JobPartsVerdictAct`) and requiring non-null `source.projectHash`, a `draft` selector and `source.parts`. Historical `rig-review/act@2` `parts-verdict` acts remain in the `JobAct` union via `JobLegacyAct` with `value: JobLegacyPartsVerdictValue` (`verdict` as `'pending'`, `'approved'` or `'changes-requested'`, `parts` with `partId`, `part` outcome and note, `mesh` outcome and note with `JobPartOutcome` as `'pending'`, `'clean'` or `'flagged'`, and `words`).
- **`review-verdict`.** The model branch carries `stage` (`'rig-review'` or `'direction-review'`) and `verdict`, requiring non-null `source.model` with runtime stage, selector and direction consistency checks. Direction submits ordered [comments](#direction-verdict-comments) or legacy `words`. A declared `rig-review` ask can also bind a `draft` selector with `source.projectHash` and null `source.direction`. It uses the existing rig screen and still capture, and its finalized act preserves the retained draft publication's source hash, model and selector. A compiled rig's Request changes can carry [chest landmarks (act@9)](#chest-landmarks-on-request-changes-act9).
- **`signoff`.** `JobActValues['signoff']` carries `stage` (validated by Create's writer), `decision` restricted to `'approved'` only (changes requested are a verdict, never a signoff) and required `words` preserved verbatim including empty or whitespace-only strings. A verdict, a signoff and a Create stage transition are three separate writes, and `JobAct` grants no transition authority. Every stage in `JOB_PLAN_BOUND_SIGNOFF_STAGES` (`'plan-approved'`, `'rigging-interview'`, `'post-interview'`) requires non-null `source.plan` with exact displayed step IDs and hashes before act creation, while other stages keep `source.plan` nullable where appropriate.
- **Create-published step IDs and hashes.** `JobPlanIdentity` holds `steps` (`id` and `hash`) published by [Create #184](https://github.com/rig-c/create/issues/184) for the displayed plan. Review retains these values without importing or recomputing Create's internal `stepHash`. Create validates them through its existing `steps` and `step_hashes` writer logic, with no separate plan revision hash or additional revision gate in this contract.
- **C4 manifest-referenced parts PNG identity.** C4 binds the exact public `partsFileReferences(dir)` array from `@rig-c/parts/src/parts.ts`, whose contract is frozen at Parts 2.25.0. The trusted host resolves an installed version in `JOB_PARTS_ENUMERATOR_RANGE` (`>=2.25.0 <3.0.0`), supplies its actual version and official callback through `partsEnumerator`, and declares `partsEnumeratorId`. `JobPartsIdentity.enumeratorVersion` carries that actual version. Manifest paths are work-root-relative and image paths are relative to the manifest directory. Each image carries `path`, bounded-string `role` and raw-byte `sha256`. Review compares the claimed array positionally with the official array, preserving its role/order/duplicate semantics. Upstream roles include `part`, `alternate`, `depth`, `painting` and `figure_mask`. Review bounds shape and paths, refuses traversal/symlinks, decodes PNGs and hashes retained bytes. Missing references refuse with row, role and path, including a missing sibling figure mask when a render copy exists. Unreferenced extras stay outside this parts identity. Composite source hashes use `rig-review-job-source/2`. Create #184 production reader/projection and official-hook wiring landed in [Create #251](https://github.com/rig-c/create/pull/251) and [Create #259](https://github.com/rig-c/create/pull/259).

### Previous accepted draft Difference

A trusted reader may declare optional `previousDraft` at the top level of a
`draft` publication context, alongside `checkpointEvidence`. Its closed
shape is the same in the publication declaration and the finalized act's
optional `source.previousDraft` binding. Review includes it in the source
digest with the sealed file identities. [Review #914 HQ sign](https://github.com/rig-c/review/issues/914#issuecomment-7001341100)

```ts
previousDraft?: {
  schema: 'rig-review-previous-draft/1';
  draft: {id: string; revision: string};
  composites: {
    current: {path: string; sha256: string};
    previous: {path: string; sha256: string};
  };
  diff?: {path: string; sha256: string};
}
```

The publisher selects the latest live `parts-review` signoff for the same
project with a null checkpoint, a different draft ID and an approved recorded
verdict. It verifies each retained Parts `assemble` recomposite against its
bound hash and seals the original bytes. It omits the declaration when no
qualifying draft, retained composite or bound hash is available. Review
validates the declared ID with `jobId` and the revision as lowercase SHA-256.
The labelled select in the secondary toolbar shows the previous ID.
When that operand is selected, its title shows
the ID and full revision. Resolution of the accepted draft stays with the
publisher. [Publisher confirmation](https://github.com/rig-c/review/issues/914#issuecomment-7001422013)

Both composites are straight-alpha RGBA8 PNGs at the current `rig_size`.
Every declared path is work-root-relative and matches a path and SHA-256
pair in the publication's `files` closure. Existing limits apply: 4,096
files, 64 MiB per raw file or decoded RGBA raster, and 256 MiB total.
The declaration is limited to 4 KiB and the optional `diff` to 1 MiB.
Parts `diff-drafts` writes `rig-parts-draft-diff/1` under `spec`
([Parts #1369](https://github.com/rig-c/parts/issues/1369)). Review reads
that marker under `schema` and looks for both declared composite hashes among
the JSON string values, so the stock Parts report is refused
(`JOB_SOURCE_MISMATCH`, detail `PREVIOUS_DRAFT_DIFF_INVALID`) until
[Review #1163](https://github.com/rig-c/review/issues/1163). Review displays
no figures for this operand.

In assembled Difference, Painting is the default when `painting_in_rig`
is available. The Previous accepted draft operand is offered only when
`previousDraft` is present. If only the previous draft is available,
assembled Difference opens on that operand. Single-part Difference
continues to use the painting. The existing Difference route uses
`stage-parts/difference/0?threshold=<n>&footprints=false&operand=previous-draft`
for the whole-canvas raster. The raster pairs native cells where either
composite has nonzero alpha, using the maximum absolute channel delta over
RGBA. New interactive Parts Difference comparisons use a fixed threshold of
`0` for either operand. The workspace has no threshold input. The shared
route and comparison record keep the integer `0–255` range, and the raster
highlights deltas strictly greater than the threshold. Zoom, Fit, 1:1 and
the view switch work as before. Review displays the raster as visual evidence
and computes no figures for this operand. The reviewer submits their verdict
through the existing act flow.
The painting loop on pre-feature main `d82aff4`
(`src/parts-comparison.ts:26–43`) skips cells with zero current alpha and
takes the maximum RGB delta. Including either alpha and all four channels
makes a removed silhouette or an alpha-only edit visible.

Pointed comments made in this view carry
`view.comparison: {mode: 'difference', opacity, threshold, operand: 'previous-draft'}`
in their parts anchor. Other comments omit `operand`. Historical comments
and publications without these optional keys retain their existing readers
and behavior. The absence of `previousDraft` is a valid publication.

Admission reports the following bounded details under `JOB_SOURCE_MISMATCH`,
except for the limit refusal.

| Detail | Condition |
| --- | --- |
| `PREVIOUS_DRAFT_INVALID` | Wrong keys or schema, or a malformed ID, revision or file identity. |
| `PREVIOUS_DRAFT_SELECTOR` | The declaration is on a non-draft selector or a record publication. |
| `PREVIOUS_DRAFT_SELF` | The previous ID equals the current draft ID. |
| `PREVIOUS_DRAFT_UNSEALED operand=<current\|previous\|diff>` | A declared path and hash are absent from the sealed file closure. |
| `PREVIOUS_DRAFT_MISSING operand=… path=…` | The declared file is absent. |
| `PREVIOUS_DRAFT_HASH_MISMATCH operand=…` | The bytes differ from the declared hash. |
| `PREVIOUS_DRAFT_PNG_INVALID operand=…` | A composite fails RGBA8 PNG validation. |
| `PREVIOUS_DRAFT_SIZE operand=… expected=WxH received=WxH` | A composite differs from `rig_size`. |
| `PREVIOUS_DRAFT_LIMIT operand=…` | A file or declaration exceeds a bound. The outer code is `JOB_SOURCE_UNRETAINABLE`. |
| `PREVIOUS_DRAFT_DIFF_INVALID` | The optional file fails the schema-string or two-composite hash check. |

The publisher emits this field only when installed Review exports
`JOB_PREVIOUS_DRAFT_SCHEMA` with value `rig-review-previous-draft/1` from
`@rig-c/review/job-host`. This is the publisher-to-Review capability rule.
Both act keys require an admitted `previousDraft`. An older Review ignores
the extra context key and treats the composite `files` rows as ordinary
seals. On the pre-feature main
`d82aff4`, the in-process `readPublished` seam is in
`src/job-source.ts:1333–1335`, the context type at `:59–67`, and the
named reads of `selector`, `files` and `plan` at `:1339–1340` and
`:223–233`. `prepareJobSource` reads the known context fields without an
exact-key check on the context. The nested `context.parts` check is at
`:265`. [HQ compatibility and emission ruling](https://github.com/rig-c/review/issues/914#issuecomment-7001361948)

### Rig verdict still backend

New rig-review verdicts use `rig-review/act@3` and a top-level `still` with `path`, `sha256`, `camera:"fixed"` and `frame`. The path is exactly `<sha256>.png`. Setup uses `frame:"setup"`. Numeric seconds require `animation` alongside the frame. Other new acts and historical rig acts retain act@2. `JOB_ACT_SCHEMA`, API@2, stored compatibility markers and the twelve public facade runtime exports retain their established values. The rig-specific revision constant is internal to the contract module. Public type exports include `JobRigReviewAct`, `JobRigStill` and `JobRigCapture`.

The authenticated rig UI submission accepts `capture` alongside the human `value`. Its closed fields are `png` as a PNG data URI, `width`, `height`, `camera`, `framing`, `view`, `frame`, optional `animation`, `playing` and `binding`. Binding contains `publicationId`, `instanceKey`, `sourceHash`, `pageId`, `askId`, `drawGeneration` and `playerGeneration`. The daemon compares source/page/ask/instance identity with the current displayed nonce and derives the hash and filename from validated PNG bytes. Draw provenance is supplied by the authenticated human UI. The PNG is the whole default-camera Rig viewport and its background, with tool overlays excluded. The standing window normally composites the player's model rasters and background into one visible canonical bitmap, with tool overlays kept separate. Capture synchronously makes only an equal-size copy of that committed bitmap without pausing active playback. Model rendering and background composition occur exclusively during normal presentation. Whole-device-pixel global translation of the unchanged bitmap preserves capture eligibility. Changes to device-pixel phase, pane-local placement or extent, source binding, or player/frame generation refuse capture. A successful public draw snapshot binds canonical bitmap identity, native dimensions, CSS size and DPR, local placement and device-pixel phase together with the public wrapped clip time (`entry(0).animationTime` as numeric `frame`), internal unwrapped `trackTime` (`player.time`), loop state, animation and source before asynchronous PNG encoding. The first full request and human words are retained unchanged for reply-loss retry across subsequent motion or transport changes. The inspection transport starts paused on `Setup` (`Play` disabled, `Repeat` enabled), drives continuous playback through public `Play`/`Pause` and `Repeat` controls over an owned `requestAnimationFrame` loop, pauses on clip selection or manual time seek, and on a `Repeat` toggle explicitly restarts the clip with the new loop flag and deterministically seeks the current visible time (resetting physics carry and frame delta). Owned animation frames and playback stop on source replacement, hidden-hub visibility transitions, `pagehide` and unmount. Exact-pixel acceptance in an overlay-free square fixture compares the full viewport screenshot against the exported CLI PNG for paused captures, and compares the synchronously sampled canonical bitmap, copied encoding canvas and exported CLI PNG at `toBlob` entry for moving captures while playback continues. Frame chrome lies outside the capture contract.

Failed capture, nondefault camera/framing, solo/highlight/comparison and mismatched binding refuse by name. Playing is accepted. Raw PNG is bounded to 8 MiB, each axis to 16384 and the decoded image to 16,777,216 pixels. Only authenticated same-origin rig-capture submissions may use a 12 MiB JSON body. Ordinary mutations retain 256 KiB. Authenticated UI act submissions with inline comment images also use the 12 MiB JSON bound (#790); unrelated mutations keep their existing bound. Comment PNGs are stored once by SHA-256 in the same transactional SQLite store as verdict stills. Private job documents and browser events retain content-addressed references; the browser retrieves the original PNG through a job-scoped, UI-capability-protected route and checks its digest before restoring the full comment. Finalized acts from consumer fetch, raw export, agent `next` and the CLI retain the original inline PNGs, key order and exact bytes. A full act and consumer event batch are bounded to 16 MiB; browser event metadata retains the 512 KiB bound. No pixels, text, anchors or historical codecs are changed. PNG BLOB, losslessly packed act bytes, act, replay, answered ask and event commit in one SQLite transaction. Retried submissions reuse the immutable first act. Close revokes fetch while preserving the act and PNG for the act lifetime. Closed jobs retain UI-capability-protected, read-only access to comment crops referenced by their recorded events, so a browser can finish consuming the act and closure. A failed crop read is marked unavailable in the browser event only and does not prevent later events or closure from being consumed; finalized consumer acts remain unchanged.

The existing consumer POST `/jobs/<jobId>/api` accepts the unchanged fetch-act body and existing bearer grant. Default/JSON Accept returns the existing API envelope. `Accept: application/vnd.rig-review.act+json` returns raw act bytes, and `Accept: image/png` returns the bound PNG for the same actId. Destination paths stay local to the CLI.

The consumer CLI bounds stdin to 4096 bytes and accepts one existing 64-hex grant with an optional final newline. It bounds raw act reads to 16 MiB and PNG reads to 8 MiB independently of Content-Length. It validates both responses before writing a PNG temporary file inside the existing consumer directory, fsyncs the file, renames it to the content-addressed filename, fsyncs the destination directory and then writes exact act bytes to stdout. Per-directory local output serialization preserves existing verified PNGs and refuses conflicting files or a retained `.rig-review-still.lock`, naming the exact local lock path without automatically deleting another writer's lock. Pre-stdout failure removes only this invocation's files. A MIDWRITE EPIPE exits nonzero and may leave the installed PNG. The consumer ignores partial stdout on nonzero exit and owns act.json persistence and pair staging.

The consumer writes successful stdout verbatim as act.json beside the PNG and hashes those exact bytes itself. The act contains the PNG hash only. No self-hash, manifest, envelope, private binding discovery or destination filesystem endpoint is introduced.

| Refusal | Condition | Remedy |
| --- | --- | --- |
| `JOB_STILL_CAPTURE_FAILED` | The Rig still is missing or could not be captured, its frame or PNG fails validation, or the stored or fetched still fails an integrity check. | Wait for a successful Rig draw and try the verdict again. If retrieval still fails, ask the host operator to check the retained act and PNG. |
| `JOB_STILL_CAMERA_NOT_FIXED` | The submitted capture uses a nonfixed camera or nondefault framing. | Restore the fixed camera and default framing, then submit again. |
| `JOB_STILL_VIEW_UNSUPPORTED` | The submitted capture is outside the whole-rig view, such as solo, highlight or comparison. | Return to the whole-rig view and submit again. |
| `JOB_STILL_BINDING_MISMATCH` | The publication, instance, displayed source, page or ask differs from the capture binding, or the draw or player generation is invalid. | Wait for the current Rig to draw and start a new verdict attempt. |
| `JOB_STILL_UNAVAILABLE` | A PNG is requested for a historical or non-rig act with no retained still. | Fetch that act without `--still-out` or an image Accept header. For a new still, reopen the current Rig review. |
| `JOB_STILL_OUTPUT_FAILED` | `--still-out` is missing for an act with a still, or the CLI cannot complete PNG or stdout output. | Supply an existing writable destination directory and check for output conflicts. If a retained lock is reported, wait for the other writer to finish or remove the named lock if a killed process left it. Ignore partial stdout on nonzero exit. |

### C4 schema and stored-state compatibility

API@1 and unsupported requests refuse `JOB_REQUEST_INVALID` with `JOB_API_SCHEMA_MISMATCH`, HTTP 400, the current API@2 response schema and unchanged generation. The CLI checks response schema before consuming its value. Consumer writers check act@2 for ordinary/historical acts and act@3 for new rig-review verdicts with a still. JobData and host descriptors carry explicit `apiSchema` and `actSchema` markers. Missing or old stored markers refuse `JOB_STORED_SCHEMA_MISMATCH` before credentials, status or replay. Authenticated active-listener reuse compares declared hook IDs, API/act schemas and the actual enumerator version. A stopped listener can be explicitly restarted for the same job with new valid hook IDs. Old retained documents and approvals remain under their original schemas and are never migrated or relabelled. Legacy one-shot contracts retain their documented boundaries.

The manifest and complete retained image rows enter the composite source hash. Limits are 4096 rows, 128 UTF-16 role units, 4096 path units, 64 MiB per raw file or decoded RGBA allocation and 256 MiB unique retained bytes. Source-bound refusals retain the old head and generation. Reference-set, path, missing-file, PNG, hash and limit details are bounded. A missing row names its official zero-based index, role and manifest-relative path. Create #184 owns its production record projection and consumer checks, which landed in [Create #251](https://github.com/rig-c/create/pull/251) and [Create #258](https://github.com/rig-c/create/pull/258). [Public boundary](STABILITY.md#parts-enumeration-boundary).

### Writer-owned sibling fetch capability and consumer writes

- **Sibling binding ownership.** `JOB_CONSUMER_AUTH_MODE` is `'writer-owned-sibling-fetch-capability'` (`JobConsumerGrant` with `jobId`, `operation` set to `'fetch-act'`, `actKinds` and `lifetime` set to `'until-explicit-close'`). [Create #184](https://github.com/rig-c/create/issues/184) owns creation and path of a private writer-owned sibling binding outside `project.json`. The versioned record carries only the semantic job locator, and the Create writer uses the binding to fetch finalized acts. The binding is never tracked in version control, never present in unstaged project output and never shipped in templates, public examples or fixtures.
- **Agent isolation and capability lifecycle.** The consumer writer reads its own sibling binding directly. Agents never construct, parse or carry Review session, picks, verdict, applied-record or sibling-binding files. Actual separate-UID isolation remains required for Review's distinct state unreadability test (`JOB_AGENT_ISOLATION_HOLE`), and no same-user forger-resistance claim is made. The random per-job bearer capability grants finalized act fetch (`fetch-act`) only, via exact loopback routes and `Authorization`. Neither `next` nor `status` returns it, and human metadata alone never authenticates a fetch. The capability dies at explicit `close`, old project history cannot restore it, each new job incarnation receives a new grant, invalid grants refuse with `JOB_CAPABILITY_REQUIRED` or `JOB_AUTHORITY_REFUSED` and closed-job fetches refuse with `JOB_CLOSED`. No self-service grant API exists.
- **Consumer deduplication and in-process mesh consumption.** Verdict, signoff and stage transition remain separate consumer writes. For these writes, consumers deduplicate `actId` before checking the current source, then validate each new source and atomically commit the result with its replay identity. Replaying an applied `actId` returns the existing record. A new stale act refuses before mutation. The typed mesh relay uses per-edit identity as defined in [Mesh edits on Request changes (act@8)](#mesh-edits-on-request-changes-act8).
- **Error codes.** `JOB_ERROR_CODES` enumerates the closed refusal set (`JOB_REQUEST_INVALID`, `JOB_BODY_LIMIT`, `JOB_LOOPBACK_REQUIRED`, `JOB_SAME_ORIGIN_REQUIRED`, `JOB_CAPABILITY_REQUIRED`, `JOB_AUTHORITY_REFUSED`, `JOB_UNKNOWN`, `JOB_CLOSED`, `JOB_GENERATION_STALE`, `JOB_IDEMPOTENCY_CONFLICT`, `JOB_FREEZE_REQUIRED`, `JOB_RECORD_INCOMPLETE`, `JOB_RECORD_MOVED`, `JOB_SOURCE_MISMATCH`, `JOB_SOURCE_UNRETAINABLE`, `JOB_ROOT_REPLACED`, `JOB_PUBLICATION_UNKNOWN`, `JOB_SNAPSHOT_RECLAIMED`, `JOB_ASK_INVALID`, `JOB_ASK_SUPERSEDED`, `JOB_ACT_UNKNOWN`, `JOB_ACT_INVALID`, `JOB_ACT_KIND_DISABLED`, `JOB_ACT_SOURCE_STALE`, `JOB_DISPLAY_MISMATCH`, `JOB_CURSOR_INVALID`, `JOB_STORAGE_FAILED`, `JOB_AGENT_ISOLATION_HOLE`, `JOB_OPTION_SET_DUPLICATE`), each returning bounded safe detail with no arbitrary worker text or private paths.

### Model-free record mode and source seam

<a id="preparatory-model-free-record-contract-and-source-seam"></a>

`src/job-contract.ts`, `src/job-api.ts`, `src/job-source.ts`, `src/job-act.ts`, `src/job-session.ts`, `src/job-front.ts`, `src/job-host.ts` and `web/job-session.ts` implement and export the active model-free record mode (`rig-review/job-api@3` and `rig-review/act@4`). When a host or session is started with `readRecordPublished` and a non-empty `recordReaderId` (`publicationMode: 'record-and-package'`), `createJobHostPorts` and `JobSession` serve `option-set`, `plan` and `package` publications, `ask`, `ask-batch`, `next` (`JOB_CAPABILITIES_V3`), `fetch-act` (`rig-review/act@4` for record acts alongside `rig-review/act@2` and `rig-review/act@3` for package acts) and `close` under `rig-review/job-api@3`. On the normal owner URL (`/jobs/<jobId>/?#cap=...`), `retainedPublicationRoutes` serves retained record publications with `recordSource` and the publication's `sourceHash`. `api/review` defaults to model-free metadata, and `api/interview` serves retained `option-set` questions and sealed option images. `prepareJobInspection` and `createJobWindow` render model-free `option-set` and `plan` inspection panels and submit human decisions that finalize `rig-review/act@4` acts (preserving existing `JOB_VISUAL_UNAVAILABLE` / `MODEL_UNAVAILABLE` behavior for package publications). `@rig-c/review/job-host` exports `JOB_API_V3_SCHEMA`, `JOB_RECORD_ACT_SCHEMA`, `JOB_RECORD_READER_ID`, `parseRecordAct`, `prepareJobRecordAct`, `prepareJobRecordSource` and the V3/record type surface (`JobRecordAct`, `JobActV3`, `JobPlanSource`, `JobFetchActRequestV3`, `JobRecordHostHooks`, `JobDisplayPublicationV3`, `DisplayPublicationV3` and companion types). [Review #561](https://github.com/rig-c/review/issues/561), [Review #588](https://github.com/rig-c/review/issues/588), [Review #586](https://github.com/rig-c/review/issues/586).

A post-interview option set with a `rig` context can also show the accepted rig as its question picture. Review resolves the version and verifies the operative human rig-review signoff's package hash from sealed `project.json`. It requires matching publication seals for every recorded `out/check/build/` row under `derived/review/v<n>/`, then opens the retained `out/check` with the folder adapter and producer handoff disabled. Only the bound compiled model and its page images are exposed through the existing assets route. On success, `api/review` includes the rig manifest and model metadata alongside the same record identity, and `api/interview` omits `missingPicture`. Historical records without this closure, including rigs signed against `outputs`, retain the model-free response and existing missing-picture message. A failed closure check uses the same fallback and leaves the question answerable. [Review #929](https://github.com/rig-c/review/issues/929).

`JOB_API_SCHEMA` (`rig-review/job-api@2`), `JOB_ACT_SCHEMA` (`rig-review/act@2`), `JOB_CAPABILITIES` (`{}`) and default hosts started without `readRecordPublished` (`publicationMode: 'package-only'`) preserve their existing package-only behavior and exact `job-ui/<jobId>.json` descriptor bytes, and reject `rig-review/job-api@3` or tagged record publish requests with HTTP 400 (`JOB_REQUEST_INVALID` / `JOB_API_SCHEMA_MISMATCH`), leaving generation and committed head unchanged. Host startup validates `readRecordPublished`, `recordReaderId` and `publicationMode` on cold start, ordinary reuse and strict `reuseOnly` attachment (`JOB_HOST_OPTION_ID_INVALID` on mismatched hook/ID pairing; `JOB_HOST_REUSE_MISMATCH` on `publicationMode`, `apiSchema`, `actSchema` or `recordReaderId` drift so a package-only listener and a record-mode listener or two different record readers never silently substitute for one another). Satisfied prerequisites are [Review #563](https://github.com/rig-c/review/issues/563) (closed), [Create #277](https://github.com/rig-c/create/issues/277) (closed), [Create #279](https://github.com/rig-c/create/issues/279) (closed), [Create #285](https://github.com/rig-c/create/issues/285) (closed), [Create #286](https://github.com/rig-c/create/issues/286) (closed) and the real Review EN/KO fixture loop proved in [Review #590](https://github.com/rig-c/review/issues/590). Remaining external and cross-repository gates are [Create #278](https://github.com/rig-c/create/issues/278) (open writer consumer fetch, ingest and freeze integration), [Create #317](https://github.com/rig-c/create/issues/317) (waiting on [Review #588](https://github.com/rig-c/review/issues/588) activation) and HQ exact-head sign-off.

| Surface | Exact keys or closed values |
| --- | --- |
| `PublishResultV3` | `{kind, path, selector}` (`package`), `{kind, questionId, setId}` or `{kind, questionId, setId, sets}` (`option-set`, `sets` 2–64 `{questionId, setId}` with `sets[0]` equal to the first set), `{kind}` (`plan`) |
| `RecordFreeze` | `{kind: 'producer-held', holdId, record: {path: 'project.json', sha256}}` |
| `RecordSubject` | `{kind: 'interview-picks', questionId, setId}`, `{kind: 'checkpoint', checkpointId}`, `{kind: 'signoff', stage}` (`plan-approved`, `rigging-interview`, `post-interview`, `direction-review`, `interview`), `{kind: 'reopen', stage}` (read only: old records parse, Review neither asks nor renders it) |
| `RecordPublishedContext` | Required `['label', 'parts', 'inputs', 'files', 'plan', 'subjects']`, optional `checkpointEvidence` and `planPicture` on plans |
| `RecordPartsIdentity` | `['name', 'version', 'integrity']` |
| `RecordSource` | Required `['sourceHash', 'projectHash', 'record', 'inputs', 'files', 'subject', 'selection', 'optionSet', 'optionSetFile', 'plan', 'subjects']`, optional `checkpointEvidence` and `planPicture` on plans, optional `optionSets` (`{questionId, setId, optionSet, optionSetFile}` per set) on several-set option-set sources |
| `rig-review-job-record-source/1` | Required `['schema', 'record', 'selection', 'inputs', 'optionSet', 'optionSetFile', 'plan', 'subjects', 'files']`, optional `checkpointEvidence` then `planPicture` on plans |
| `rig-review-job-record-instance/1` | `['schema', 'fingerprint', 'sourceHash']` |
| `JobCapabilitiesV3` | `{recordPublication: true, recordActSchema: 'rig-review/act@4', askBatch: true, progress: true}` |
| `AskBatchRequestV3` | `{schema, jobId, requestId, verb: 'ask-batch', expectedGeneration, idempotencyKey, publicationId, subjects}`, `subjects` 1–64 |
| `AskBatchValueV3` | `{asks}`, where `asks[i]` answers `subjects[i]` |
| `JobProgressRequestV3` | `{schema, jobId, requestId, verb: 'progress', seq, phase, text?, step?}` |
| `JobProgressValueV3` | `{status, seq, at}`, where `status` is `'accepted'` or `'ignored'` |
| `JobProgressV3` | `{seq, phase, text?, step?, at, generation}` |
| `JobProgressLineV3` | `{type: 'progress', jobId, progress, now}`, where `progress` is `JobProgressV3` or `null` |

<a id="option-sets"></a>

An `option-set` publication carries 1 to 64 sets ([Review #1004](https://github.com/rig-c/review/issues/1004)). One set keeps the single encoding: `{kind, questionId, setId}`, no `sets`, no `optionSets`, and source bytes and `sourceHash` identical to the one-set source before #1004. Several sets name the first set in `questionId` and `setId` and list every set in order in `sets`. The reader's context declares exactly one `interview-picks` subject per set, in the same order; any other subject list refuses with the existing code. The retained source's singular `selection`, `optionSet` and `optionSetFile` name the first set, `selection.sets` repeats `sets`, and `optionSets` carries each set's own option-set identity and file. Each ask binds its own set: `ask` or `ask-batch` takes any declared set's subject, and a set the publication does not carry refuses `JOB_ASK_INVALID`. The asks of one publication are pending at the same time and none supersedes another; publishing a new head still supersedes every pending ask of the old one, and the [Review #1022](https://github.com/rig-c/review/issues/1022) replay rule is unchanged. Each answer finalizes one `interview-picks` act (`rig-review/act@6`) for its own set and leaves the other asks pending. At K ≥ 2 an act's `source` names that act's own set: `selection` is `{kind: 'option-set', questionId, setId, sets}` with this act's `questionId` and `setId` and `sets` unchanged, `optionSet` is `{id: <this setId>, sha256: <this set's sha256>}` and `optionSetFile` is this set's file binding. `subjects`, `optionSets` and `sourceHash` stay the publication's. To re-derive `sourceHash` from an act, put set 0 back into the singular fields (`selection.questionId`/`setId` from `sets[0]`, `optionSet` and `optionSetFile` from `optionSets[0]`) and digest that publication source. An act whose per-act fields disagree refuses `JOB_ACT_INVALID` by name: a `selection` set the publication does not carry (`act set <q>/<s> is not published`), an `optionSet` that is not that set's (`act optionSet does not name set <q>/<s>`), an `optionSetFile` that is not that set's file (`act optionSetFile is not the file of set <q>/<s>`), or a `value.questionId` other than `selection.questionId` (`value.questionId <q> is not the act set <q>/<s>`). A K ≥ 2 act in the publication encoding (singular fields on set 0) for any other set therefore refuses. One set retains the singular source encoding. Two subjects for one set refuse `JOB_OPTION_SET_DUPLICATE` (`two subjects for set <questionId>/<setId>`), a set named twice in `sets` refuses `JOB_OPTION_SET_DUPLICATE` (`set <questionId>/<setId> is named twice`), and a `sets` of one entry or with a first entry other than the first set refuses `JOB_REQUEST_INVALID`; none of them reads the publisher or moves the generation. On the owner page the sets share one question list with one "Submit review (n/K)" at its top, where n counts the sets that are answered or fully picked. Submit sends each picked, unsubmitted set through its own form, one act each; the other sets stay pending and on the page.

<a id="ask-batch"></a>

`ask-batch` asks several subjects of the head record publication in one request ([Review #963](https://github.com/rig-c/review/issues/963)). Each subject is parsed exactly like the single `ask` subject, and a repeated subject refuses the batch. A package head refuses `JOB_REQUEST_INVALID`, a non-head publication refuses `JOB_ACT_SOURCE_STALE`, and zero or more than 64 subjects refuse `JOB_REQUEST_INVALID`. The existing 256 KiB body limit still applies. Review binds every subject, runs `verifyJobRecordSourceFresh` once for the batch (one `inventory` and one `retained` reader call) and validates each subject against that one fresh source. One immediate transaction then re-checks the head, the work root and the retained snapshot once and creates every ask. Each ask writes its own `pending` event and moves the generation by 1, so a batch of N moves it by N. The batch is all or none: any refusal creates no ask, no event and no generation change. A subject's refusal keeps its existing code and prefixes the message with `subjects[<i>]: `. A freshness refusal carries no index. One idempotency key replays the whole batch without reading the publisher again. The replay follows the same rule as a single `ask`: if any ask of the stored batch is no longer pending and has no finalized act, the replay refuses `JOB_ASK_SUPERSEDED` with the message prefixed by that ask's `subjects[<i>]: `. Single `ask` and finalize are unchanged. A Create detects support through `capabilities.askBatch` in `next`, never by sending `ask-batch` and reading the refusal: an older Review answers the unknown verb with `JOB_REQUEST_INVALID`. In `JobCapabilitiesV3`, `recordPublication`, `recordActSchema` and `askBatch` describe the host rather than the current head: `ask-batch` applies only to a record-retained head publication and a package head refuses `JOB_REQUEST_INVALID`, so a consumer checks the publication's mode as well as the flag.

<a id="job-progress"></a>

**Progress between publications.** A `rig-review/job-api@3` agent checks `capabilities.progress === true` in `next`, then sends `progress` through the existing agent-authenticated `POST /jobs/<jobId>/api`. Support applies before the first publication and with either publication kind on a V3 host. The closed request allows `seq` as a positive safe integer, `phase` as one of `ingest`, `build`, `measure`, `publish` or `other`, optional single-line `text` of at most 120 characters, and optional `step: {i, n}` with safe integers satisfying `1 ≤ i ≤ n ≤ 1000`. Text is agent-authored and displayed verbatim. The raw JSON body limit is 1,024 bytes for progress. Invalid shapes and this verb's bounds refuse `JOB_REQUEST_INVALID`, and a closed job refuses `JOB_CLOSED`. The shared transport still enforces its global body limit before parsing a verb.

The normal V3 reply envelope contains `value: {status, seq, at}`. Review supplies the ISO receipt time `at` and stores the latest progress with the current job generation. Sequences increase across the job's lifetime. A request with a sequence at or below the last accepted sequence returns `ignored` with that sequence and receipt time, including after a clear or restart. An accepted request replaces the slot without an event, generation increment or replay entry. A committed `publish`, `ask`, `ask-batch` or `close` clears the visible slot. A retry of a committed mutation leaves subsequent progress in place.

The V3 owner page's existing `GET /jobs/<jobId>/events` NDJSON stream emits a cursorless `JobProgressLineV3` with the current slot on connect. `progress` is `null` when the slot is empty, and `now` is ISO host time. While connected, progress writes are coalesced per job to at most one update per second, with the latest value delivered after the interval even if writes stop. Connect snapshots and clears associated with semantic events are delivered independently of that cadence. The trusted `subscribeJob` port, semantic `next` cursors and CLI continue to use only durable job events.

The read-only official reader returns the six-key `RecordPublishedContext` with producer-sealed `parts`. `prepareJobRecordSource` runs `phase: 'inventory'` on the immutable source root (re-verifying `project.json` identity before and after each reader phase and before mapping generic reader failures so mid-read record movement reports `JOB_RECORD_MOVED` / `JOB_SOURCE_MISMATCH` rather than `JOB_RECORD_INCOMPLETE`) and retains the sorted, duplicate-free `inventory.files` closure into an owned snapshot (`project.json` within 8 MiB, at most 4,096 regular non-symlink files, 64 MiB per file and 256 MiB total bytes). It then calls `phase: 'retained'` on the snapshot root with `parts: inventory.parts` forwarded unchanged and requires `assertEqualRecordContexts(inventory, retainedContext)`. Before ask or finalize, `verifyJobRecordSourceFresh` re-runs `phase: 'inventory'`, rejects any `inventory.parts` drift against the originally sealed `retained.context.parts` (`JOB_SOURCE_MISMATCH` on ask and `JOB_ACT_SOURCE_STALE` on finalize) before invoking `phase: 'retained'`, and forwards the sealed `retained.context.parts` unchanged when equal; synchronous `store.update` commit re-verifies source and retained snapshot integrity before persisting. Missing reader or contract tokens (`CREATE_PUBLICATION_CONTRACT_UNAVAILABLE`, `CREATE_PLAN_PUBLICATION_CONTRACT_UNAVAILABLE`) refuse with `JOB_SOURCE_UNRETAINABLE`, while named producer tokens (`JOB_RECORD_CLOSURE_INCOMPLETE`, `JOB_RECORD_PARTS_MISMATCH`, `JOB_RECORD_PARTS_LOCK_MISSING`) map to `JOB_RECORD_INCOMPLETE` on publish or ask and `JOB_ACT_SOURCE_STALE` on finalize.

`interview-picks` records carry `plan: null` and remain valid for source preparation, ask binding and `rig-review/act@6` preparation. An inspection-only plan record with `plan: {steps: []}` and `subjects: []` is valid for source preparation and freshness checks, while plan `checkpoint` and `signoff` ask binding and `rig-review/act@4` preparation require non-empty `plan.steps` and declared subjects (`JOB_ASK_INVALID` / `JOB_ACT_INVALID`), and plan `reopen` ask binding and `rig-review/act@4` `{stage, words}` preparation require a declared `{kind: 'reopen', stage}` subject on a `plan` record source ([Review #586](https://github.com/rig-c/review/issues/586)). Focused unit tests cover synthetic reader doubles, normal owner URL model-free record inspection (`retainedPublicationRoutes` + `prepareJobInspection` + `createJobWindow`), and archive-backed reader-double evidence over extracted `2-rigging-answers.tar.gz` (`rig-review/job-api@3` and `rig-review/act@4` parsed by `parseRecordAct` using a local `readRecordPublished` reader double and synthetic parts integrity, distinct from official installed Create reader/consumer conformance under [Create #278](https://github.com/rig-c/create/issues/278) and [Create #317](https://github.com/rig-c/create/issues/317)).

Record `interview` and `direction-review` signoffs use the existing signoff modal and are plan-bound like `post-interview`: the published record must declare the subject and contain non-empty `plan.steps`. Each approves the frozen record revision through its project/source hashes; no separate post-version selector or new ask/act field is carried. Existing stage values and act schemas are unchanged. The public package plan-bound stage list remains the original three stages; package `direction-review` signoffs and historical package acts continue to accept `plan: null`.

For a declared `{kind: 'signoff', stage: 'direction-review'}` subject, the trusted record reader may return `directionReview` on `PlanContext` from the same frozen record revision named by the publication hashes. `PlanSource` mirrors the exact display shape `{postVersion, verdictActId, take: {duration, loop}, camera}` in the publication source and its pending ask copies. The post version is an integer of at least 1, the accepted verdict act ID is a string or `null`, the take duration is positive finite seconds, looping is a boolean, and the camera is `composed`, `fixed` or `moving`. An omitted field leaves the display details unavailable. A malformed field or a field without the declared signoff subject refuses `JOB_SOURCE_INVALID`. The projection is excluded from `files`, `inputs`, the source hash and every act.

### Optional sealed checkpoint evidence

The trusted `JobPublicationReader` package context and the record reader's
`PlanContext` may declare `checkpointEvidence`. Package-only API@2, API@3 package
publications in record-and-package mode, and model-free record plan publications
share this declaration. It is admitted only through the trusted reader and its
exact work-root-relative file closure. Each packet binds an admitted checkpoint
subject to an existing plan step. Package aliases use the subject's
`planStepId ?? checkpointId`. Record checkpoints use the same checkpoint and plan
step ID. Option-set publications refuse this extension.

The collection contains ordered packets with exactly these fields.

```ts
{
  schema: 'rig-review-checkpoint-evidence/1',
  checkpointId: string,
  planStepId: string,
  tiles: [{id: string, label: string, path: string, sha256: string}],
  table: {path: string, sha256: string, label?: string},
  routesText: string,
  recommendationText: string,
  pair?: {
    before: {id: string, sha256: string},
    after: {id: string, sha256: string}
  }
}
```

The table's sealed UTF-8 JSON document has exactly `schema`, `columns` and `rows`.
Its schema is `rig-review-checkpoint-table/1`. Columns are ordered, nonempty text
labels. Each row is an array of exactly that column count, with string, finite
number, boolean or null cells. The declaration carries only the table file seal
and optional label. The document alone supplies the table body. All rows, column
order, tile order and exact Unicode/text values are preserved. Routes and the
recommendation are verbatim text. The owner UI displays supplied text as text and
labels the recommendation through its EN/KO catalog. An evidence-bearing card's
adjacent mapping uses pass for route (i), accepting the openings, and fail plus
the owner's words for (ii) or (iii). The browser value remains
`{checkpointId, outcome, words}`. The daemon supplies the finalized `planStepId`.

Admission bounds are explicit.

| Item | Bound |
| --- | --- |
| Packets and tiles | 1–8 packets, 1–8 ordered tiles per packet, unique checkpoint IDs and tile IDs within each packet |
| Entire canonical declaration | 32 KiB UTF-8 |
| IDs and paths | Existing `jobId` 128-character and `jobPath` 4,096-character limits |
| Tile labels, optional table label and column labels | Nonempty strings, at most 512 UTF-16 units each |
| Routes and recommendation | Nonempty strings, at most 4,096 UTF-16 units each |
| Tile bytes | Static noninterlaced 8-bit RGB/RGBA PNG, at most 8 MiB, each edge at most 16,384 and at most 16,777,216 pixels, validated through the existing PNG decoder |
| Table bytes | At most 256 KiB per raw document and 512 KiB total raw table bytes per publication |
| Table dimensions | 1–32 columns, 0–2,048 rows, at most 16,384 cells per document |
| String cells | At most 2,048 UTF-16 units, including empty strings |

Text permits LF and tab and refuses other ASCII control characters. Present
`undefined`, null and empty evidence collections refuse. Missing required keys,
unknown packet/tile/table/document keys, duplicate identities, nested cells and
incorrect row widths refuse. Absent evidence stays omitted in normalized
contexts, sources, metadata and stored state. Existing 512 KiB event metadata (full consumer acts follow #790), 2 MiB owner
metadata and 16 MiB durable-document delivery/admission limits remain in force.
The declaration and table bounds leave room for existing metadata and events.
Existing closure file count and total retained-byte limits also apply.

Every tile and table path must exactly match a trusted closure member and SHA-256.
Review reuses regular-file, descriptor-based, literal portable path containment
checks, including every directory component, and rejects symlinks and escapes.
Actual PNG bytes are decoded and the table is parsed before publication.
`JOB_SOURCE_MISMATCH` carries named details `CHECKPOINT_EVIDENCE_INVALID`,
`CHECKPOINT_EVIDENCE_HASH_MISMATCH`, `CHECKPOINT_EVIDENCE_PNG_INVALID` or
`CHECKPOINT_EVIDENCE_TABLE_INVALID`. Unreadable paths or byte bounds use
`JOB_SOURCE_UNRETAINABLE` with `CHECKPOINT_EVIDENCE_PATH_REFUSED` or
`CHECKPOINT_EVIDENCE_TABLE_LIMIT`. Existing live-source and retained-snapshot
refusals still apply to movement during retention or subsequent operations.

Source binding contains the canonical `checkpointEvidence` collection. Packet
key order is `schema`, `checkpointId`, `planStepId`, `tiles`, `table`, `routesText`,
`recommendationText`, followed by `pair` only when supplied. Tile key order is `id`, `label`, `path`, `sha256`. Table
key order is `path`, `sha256`, followed by `label` only when supplied. Pair key
order is `before`, `after`, each with exact keys `id`, `sha256` naming distinct
tiles in the same packet whose declared `sha256` matches (`parseCheckpointEvidencePacket`
from `@rig-c/review/job-host`). JSON uses
these fixed keys and preserves collection order and exact strings. The package
`rig-review-job-source/2` composite preimage appends `checkpointEvidence` after
`files`. The record `rig-review-job-record-source/1` digest preimage does the same.
No evidence field is emitted or hashed for historical absence. Legacy direct
package hashes and literal historical digest/source bytes retain their existing
form. Labels, paths, IDs, routes and recommendations all participate, so a
metadata-only edit changes source and instance identity or refuses against an
already bound source. Raw table bytes are bound by their seal, including changes
that parse to the same table. Existing API, finalized-act and source schema
markers remain as documented above.

Both publication-pinned `api/review` projections conditionally include the ordered
`checkpointEvidence` collection. Metadata retains the declaration fields, adds
each tile's `url` as
`/api/checkpoint-evidence/<checkpointId>/tiles/<zero-based-index>`, and expands
`table` with its parsed `schema`, `columns`, complete `rows` and `url` as
`/api/checkpoint-evidence/<checkpointId>/table`. Both tile and table URLs are
relative to the pinned publication base, matching existing interview image URLs.
The resolver admits only a declared checkpoint member, finds its exact seal and
streams its retained bytes through the existing sealed reference route. Table
GET returns the exact retained raw JSON bytes, including their whitespace, and
supports HEAD through the same route. Its 256 KiB bound and regular-file/path/SHA
checks run before streaming. The URL is derived delivery metadata. The producer's
table declaration continues to contain only `path`, `sha256` and optional `label`.

Before presenting the projection, the owner UI fetches the pinned table URL and
checks its raw-byte SHA-256 against the source binding's declared table seal.
It parses that authenticated UTF-8 JSON and compares its `schema`, `columns` and
`rows` with the projected body, preserving every column and row in order. This
comparison uses ordinary JSON parsing and exact data equality. The backend owns
table grammar validation at admission and metadata projection. A changed metadata
row, column, order or schema under the same source hash fails that comparison.
Metadata has the same pinned source hash as the publication. A record publication
remains manifest-free. Undeclared evidence has no projection, tile or table route.

Durable reads authenticate evidence-bearing package composite hashes from the
retained base-package hash, record, selector, plan, parts and closure. The private
retained `checkpointEvidencePackageHash` stores that base hash only for this
extension. The package metadata route additionally compares it to `loadReview`
on the retained package. Record sources reuse their canonical digest parser.
Stored context, publication, ask, act, event and replay copies must agree with
the retained declaration and source identity. Null, undefined or missing source
copies for an evidence-bound publication refuse with `JOB_SOURCE_MISMATCH` before
source property access. These checks require no live files
or reclaimed historical snapshots. Retained-file integrity is checked on fresh
evidence mutations and actual asset/metadata reads. Record asks/finalizations
also repeat the existing two reader phases and reject metadata drift. Package
asks use the reader declaration pinned at publication and the existing current
record/file seals. They retain the existing single-reader publication lifecycle.
An exact committed publication/ask/act retry returns its original identity after
live output drift. A fresh mutation still validates currentness. Reopening never
adds current live evidence to an old publication.

Review owns this additive public declaration. Create #395 implementation requires
HQ signature at the exact Review shape PR head. Historical record-source readers
with the earlier closed key set refuse evidence-bearing sources. New consumers
require the signed extended contract. Owner-screen integration,
EN/KO visual verification and later release serving have their own acceptance
steps.

<a id="plan-picture"></a>

### Optional plan picture

A record-plan `PlanContext` may declare `planPicture: {path, sha256}`
([Review #983](https://github.com/rig-c/review/issues/983)): the picture the owner
signs the plan against, such as the latest post render or take the record binds.
It has exactly the keys `path` and `sha256`, and must equal an entry already in
`files`. The path must name a raster image Review draws, by the package page-image
rule: `.png`, `.jpg`, `.jpeg` or `.webp`. Option-set publications refuse it. Any
violation refuses `JOB_SOURCE_MISMATCH` with detail `PLAN_PICTURE_INVALID`.

The retained `RecordSource` carries the same `planPicture`. The
`rig-review-job-record-source/1` digest preimage appends it after `files` and any
`checkpointEvidence`, so the picture binds `sourceHash` and instance identity. An
absent declaration emits and hashes nothing: existing records parse and hash
exactly as before. The publication-pinned route `api/plan-picture` streams that
one sealed member through the existing sealed reference route, and is 404 for
records without it. The owner page checks the bytes against the declared SHA-256
before drawing.

On the record screen a declared `planPicture` ranks first: it is drawn in the main
view's reference viewport, and Review neither walks to an earlier picture
publication nor draws bound parts. Without it the picture choice is unchanged: the
record's own rig, then an earlier picture publication, then bound parts, then a
scene-context option set.

#### Pins on the plan picture

While the plan picture or a record interview's question image is shown, stage
comments pin a point or a region on it through the same pin layer as a rig view,
with no new control ([Review #1048](https://github.com/rig-c/review/issues/1048)). The row is an
ordinary StageComment-backed Feedback with `viewport: 'reference'`,
`camera.space: 'image'` and `world` in the picture's natural pixels, Y down. Its
`referenceId` and `referenceHash` name the picture, and their meaning depends on
the source that carries the pin:

- **Record publication:** `referenceId` is the `path` of an entry in that
  publication's `files`: the declared `planPicture`, or the sealed file of the
  shown question image (`api/interview` lists its `path` and `sha256`), or a tile
  of the active plan checkpoint's declared pair. `referenceHash` is that entry's sealed
  `sha256`, copied from the source and never recomputed by the page.
- **Rig package:** `referenceId` is the selected bookmark reference, and
  `referenceHash` is the loader's hash of it, as described under the comment
  context above. Nothing changes for these marks.
- **Rig package checkpoint evidence pair:** A pin on a tile of the active checkpoint's
  declared pair uses that tile's literal sealed file path as `referenceId` and its
  sealed SHA-256 as `referenceHash`. Checkpoint words use the same picture label
  as record pins. Side by side pins bind to Before on the left, and Difference
  pins bind to After. Replay resolves the same path and hash from the declared pair.

A record act carries comments only as the scalar `words` projection: checkpoint
and signoff in their `words`, interview picks in their optional `words`. A picture
pin therefore projects its own label, so the picture and the pixels reach the act:

`["rig-review-comment/1", mode, "reference", referenceId, referenceHash, x, y, w, h]`

Here `x`, `y`, `w` and `h` are `world` rounded to integers in natural pixels, Y
down, and a point has `w` and `h` of 0. Pins on a sealed plan picture, question
image, or declared pair tile take this label. Historical manifest-reference
pins keep their existing tuple byte for byte. A record pin that names the picture's path with a
different `sha256`, or whose label does not parse back to that path and hash,
refuses `COMMENT_PICTURE_LABEL_INVALID`, both when projected and when a local
draft is restored. Package pair pins with a mismatched path or hash refuse
`COMMENT_REFERENCE_MISMATCH`. New picture bytes give the record a new `sourceHash`, so an
unsent pin is not carried to the new publication; the existing "source changed …
could not be carried over" notice reports it.

### Sealed plan step text

Both publication-pinned `api/review` responses append delivery-only `planText`
when the accepted source has a plan. The daemon authenticates `project.json`
from that publication's retained snapshot against its record seal and existing
`projectHash`, then projects `does`, `produces`, `bar` and `rests_on`.

The projected envelope has ordered keys `schema`, `record`, `status`, `steps`,
and the additive optional key `questions` (present when at least one qualifying
interview item exists). `schema` remains `rig-review/job-plan-text@1`, `record`
is `{path:"project.json",sha256}`, and `status` is `projected`. Rows follow the
accepted plan's exact id/hash order. Each row has `id`, `hash`, optional `does`,
`produces`, `bar`, `rests_on`, then `issues`. Each field supplies exactly one
value or an ordered `{field,reason:"absent"|"invalid"|"limit"}` issue. Scalar
values are strings and `rests_on` is an ordered string array. Empty
strings/arrays, whitespace, line endings, Unicode form, duplicate references and
array order are preserved. When present, `questions` maps IDs to labels
collected from `interview.framing`, `interview.waypoints` and
`interview.post.items` in that order (first qualifying entry wins per id).
Qualifying ids are at most 128 characters and match
`/^[A-Za-z0-9][A-Za-z0-9._-]*$/`. A waypoint uses its nonblank `prompts[].text`
in source order, encoded as a string for one prompt or a string array for
multiple prompts. When no usable prompt exists, it uses legacy nonblank
`text` or an empty label. Other interview items keep their string `text`.
In `rests_on`, the UI resolves a known interview id first, displays each
label verbatim in its own row with the id in `title`, and uses the localized
absence text for an empty label. An id found
only in the plan resolves to its step, and unmatched ids stay raw. Producer
extras stay outside this display projection.

D1 matches only accepted ids, preserving source order and existing checkpoint
aliases (`planStepId ?? checkpointId`). D2 retains its existing whole-plan
count/ordered-id admission checks. Hashes are the producer's opaque accepted
identities. The existing reader retains responsibility for their semantic value.

The unavailable envelope has `schema`, `record` (or null),
`status:"unavailable"`, `reason`; `questions` is never present on the
unavailable envelope. Named reasons are
`PLAN_TEXT_RECORD_UNAVAILABLE`, `PLAN_TEXT_RECORD_UNSUPPORTED`,
`PLAN_TEXT_STEPS_ABSENT`, `PLAN_TEXT_STEPS_INVALID`,
`PLAN_TEXT_MAPPING_UNAVAILABLE` and `PLAN_TEXT_LIMIT`. The UI shows the named
absence and existing ids/hashes. Partial valid fields remain visible beside
their missing/invalid field labels. Existing act authority and historical
metadata omission retain their fallback behavior.

The server retains its 8 MiB project read bound. Display limits are 4,096 plan
steps, 4,096 `rests_on` rows per step after expanding prompts, and 512 KiB UTF-8 for the entire `planText`
envelope (including `questions`). Whole owner
metadata retains its 2 MiB bound. A small unavailable envelope replaces an
oversized projection. If that envelope also exceeds the response budget, the
server returns `JOB_BODY_LIMIT` with `PLAN_TEXT_LIMIT`. Values remain complete
within the admitted display budget.

The browser checks the closed grammar, metadata/source association, record SHA
and ordered id/hash mapping. Field values have the normal daemon's authority.
Type-valid post-server text mutation can pass those checks. The server's sealed
record authentication and the browser's source/grammar checks are their
respective validation boundaries. Checkpoint evidence retains its established
raw-member authentication.

This metadata is produced at response time. Source/act schemas, producer reader
DTOs, stable `job-host` exports, durable state and canonical hash preimages retain
their existing definitions. Checkpoint and signoff values continue through their
existing forms, outcome select and submission lifecycle.

Under HQ ruling 7896ec71, the official D2 consumer gate is the supported
record-checkpoint flow following Create #395 integration. Create owns the actual
producer receipt. Review's plan-signoff rendering has synthetic UI coverage.
Normal CLI plan-signoff bootstrap and `plan-approved` act@4 ingestion are a
separate Create follow-up.

## Comments decoder contract

The comments feature accepts multiple ordered entries, each general or pinned to
an existing inspection target. Surveys remain separate answer inputs: interview
selections, inline Other text and per-question notes keep their existing formats,
strings and readers. In an `interview-picks` act, structured comments sit
alongside those survey answers. Technical configuration and search controls are
outside this extension.

The decoders and consumer projections are read-only. Since [Review #713](https://github.com/rig-c/review/issues/713)
(HQ contract ruling), the UI finalizers use act@6 as the base format for
fresh checkpoint, parts-verdict, rig and direction review-verdict and signoff
acts. The UI submission for those kinds continues to accept its existing `words` and `issues` fields.
[Review #746](https://github.com/rig-c/review/issues/746)
adds optional `feedback: Feedback[]` beside required `words` only for the
`rig-review` verdict submission. When present, including an empty list,
`feedback` supplies the pinned comments and suppresses the `words` fallback.
`feedbackItemComments` maps each row's `summary` to `text` and retains its
`id`, frames, target, category and `anchor.context`. The decoder refuses
malformed or blank rows. The act bar sends a detached feedback list when there
are pinned comments and keeps `words` as their projection. It omits `feedback`
when there are no pinned comments. With `feedback` absent, nonblank `words`
still supplies one general comment.

Only the `rig-review` verdict and `parts-verdict` accept optional
`general: readonly string[]` in their UI submission values. Each string becomes
an anchorless `{text}` entry, appended verbatim in list order after the comments
produced by the existing fields. For parts verdicts, nonblank `words` still
produces a comment after the pinned `issues` and before `general`. Parts Request
changes still requires a pinned issue, and approval still requires zero issues. The existing decoder
validates the combined comment count, text, evidence and signed projection.
Omitting `general` preserves the existing written bytes. Adding `general` by
itself keeps the existing schema selection. Historical words-only acts retain
their readers. [Review #831](https://github.com/rig-c/review/issues/831).

Pointed marks, inline crops, bookmarks and valid time-only null frames remain
inside the existing `anchor.context`. [Comment context (act@7)](#comment-context-act7)
defines the separate top-level `comment.context` field.

### Direction verdict comments

[Review #1136](https://github.com/rig-c/review/issues/1136) lets a
`direction-review` UI submission carry an ordered `comments` list in place of
`words`. The finalized `rig-review/act@6` uses the existing Feedback anchor.
Each pin carries the exact held seconds, stage-local and world rectangles,
crop, numeric camera including zoom, and recorded turn when present. Pins with
an explicit producer or reference frame preserve that frame and its basis.
Time-only pins carry the seconds time basis and null `frame`, `frameStart` and
`frameEnd`. Point pins use zero width and height. The writer checks pins against the retained
publication. General comments carry `text` alone. Legacy words-only submissions
still emit a single anchorless comment for nonblank words and an empty list for
blank words. Historical act bytes and the `projectComments` projection are unchanged.

For the words-only mapping, the daemon maps a nonblank note
to one comment: anchored to the checkpoint for a checkpoint, general otherwise.
It maps each Parts issue to a Parts-anchored comment, before the note. A blank
or whitespace-only note writes no comment (`comments: []`). Nothing is padded.
A note whose projection exceeds the 10,000-unit scalar bound refuses
`JOB_ACT_INVALID`. The bound counts the stored `words`, and the `[label]\n`
prefix is part of them, so a general note longer than 9,990 units refuses even
though act@5 accepted it. Feedback is many comments, not one long note.
Each written act@6 must decode through `parseCommentsAct`.
Review no longer writes image-review verdicts. Image-review publications and
acts were removed ([Review #796](https://github.com/rig-c/review/issues/796),
[Review #1106](https://github.com/rig-c/review/issues/1106)), and an ask on
an `image-review` subject refuses. Historical act@2 image-review bytes keep
their readers. Standalone save paths keep their existing versions.

[Review #646](https://github.com/rig-c/review/issues/646) writes package and record
`interview-picks` at act@6. The value carries `questionId`, ordered `selections`,
`note` and ordered `comments`, with the existing non-null `source.optionSet`
binding. Record sources use the
[per-act set binding](#model-free-record-mode-and-source-seam).
A comment may be general or carry an existing Feedback, PartsIssue or
`JobCommentImageAnchor` anchor. Stage pins carry their stored Feedback geometry
and crop. Image anchors carry `name` and may include `imageRegion`, `crop` and
`nativeCrop` together. The decoder preserves comment text and order and refuses
`words`, unknown members and checkpoint anchors with `JOB_ACT_INVALID`.

The existing `@rig-c/review/job-host` facade exports:

| Function | Input → output |
| --- | --- |
| `parseCommentsAct` | `unknown` → `JobCommentsAct` |
| `projectComments` | `readonly JobComment[]` → `string` |
| `parseCommentsSession` | `unknown` → `ReviewCommentsSession` |
| `parseCommentsCompareSession` | `unknown` → `CompareCommentsSession` |
| `parseCommentsPartsVerdict` | `unknown` → `PartsCommentsVerdict` |
| `projectSelectedCommentsFeedback` | `ReviewCommentsSession, itemId: string` → `{anchor: JobCommentFeedbackAnchor; summary: string}` |

Use a decoder before projecting untrusted input. These functions perform no
filesystem writes. Decode success validates declared identities and syntax; it
does not grant producer/source-kind admission or prove retained asset freshness,
source-native pixels, clock availability or owner authority. Those checks stay
with the existing retained-source, package feedback and crop pipeline. The
native-image region preparation adapter is still required before image-region
writers activate.

`JOB_COMMENTS_ACT_SCHEMA` is `rig-review/act@6`. Its exact envelope keys are
`schema, actId, jobId, askId, publicationId, kind, authority, at, source, value`.
The existing top-level `still` is required only for a model `rig-review` verdict
and forbidden otherwise. It retains fixed camera, content-addressed PNG path,
SHA-256 and setup-or-numeric-animation-time validation. The raw export and CLI
reuse their existing PNG byte checks and preserve original act stdout bytes.
The authority remains daemon-owned human `review-ui` authority. Model/image
bindings and record plan sources retain their existing definitions; record
option-set sources are excluded. Source capabilities remain consumer-owned.

| Kind | Exact value keys |
| --- | --- |
| `checkpoint` | `checkpointId, planStepId, outcome, comments` (`pass` or `fail`) |
| `parts-verdict` | `verdict, comments` (`approved` or `changes-requested`) |
| `review-verdict` | `stage, verdict, comments` (existing rig/direction/image stages and verdicts) |
| `signoff` | `stage, decision, comments` (`approved`) |
| `reopen` | `stage, comments` (read only: old records parse, Review neither asks nor renders it) |

The declared plan/source/selector and ask eligibility checks remain applicable.
The browser never supplies authoritative checkpoint-to-plan mapping. A Parts
verdict is approved exactly when it has no pointed Parts issue anchors; general
comments do not create issues. Verdict and signoff remain distinct immutable
acts even when one user action will submit the same comments to both.

A `comments` array has at most 1,000 entries. Each entry has exactly `text` and
optional `anchor`. Fresh text is a nonblank string of at most 10,000 UTF-16 units;
trimming is a validation predicate and never changes the stored text. Reusing a
Feedback or Parts codec preserves its stricter existing text limit. Existing
evidence IDs stay unique. Intentional duplicate text and stored order remain.
Unknown fields and mixed anchor arms refuse.

Anchors use existing source-bound fields without a new kind discriminator:

- Feedback without `summary`: `id, frameStart, frameEnd, target, category`, with
  optional `context` and compare-only `side`. StageComment remains inside
  `context.comment`; existing codecs and inline PNG validation are reused.
- PartsIssue without `summary`: `schema, id, parts, sourceHash, rigRegion,
  imageRegion, view, crop, nativeCrop`. Finalized item anchors require prepared
  native crop metadata. Assembled anchors retain null native crop. Optional assembled-only
  `view.visibleLayers: {name, imageHash}[]` retains the complete visible set in
  source item order, bound to `sourceHash` and each loaded source image. Entries
  must be unique and source-bound before restoration replaces the hidden set.
  Starting in 4.8.0, fresh assembled capture writes this field. Readers accept
  both forms. Absence retains the historical restore branch and recorded bytes.
- Named image: `name`, optionally the complete existing-field composition
  `imageRegion, crop, nativeCrop`. Names resolve in the sealed image set. Regions
  use nonnegative native-pixel integer origins, positive extents and at most
  16,777,216 pixels. Actual image bounds and crop-to-original equality remain
  native preparation checks.
- Checkpoint: `checkpointId, planStepId`, resolved through the existing source
  plan and any declared evidence mapping.

`projectComments` traverses stored order. Each scalar block is
`[label]\n` followed by exact `text`, with `\n\n` between blocks; the empty array
projects to the empty string. The complete scalar is bounded to 10,000 UTF-16
units. Lists retain individual entries. A general label is `general`; other
labels are `JSON.stringify` of these logical target tuples:

| Anchor | Label tuple |
| --- | --- |
| Checkpoint | `["checkpoint", checkpointId]` |
| Parts | `[schema, parts.map(part => part.name), view.mode]` |
| Image | `[name]` |
| StageComment-backed Feedback | `[mark.schema, mark.mode, mark.viewport, target.kind, target.name, frameStart, frameEnd]` |
| StageComment-backed Feedback on a record's plan picture | `[mark.schema, mark.mode, "reference", referenceId, referenceHash, x, y, w, h]` ([pins on the plan picture](#pins-on-the-plan-picture)) |
| Other Feedback | `[target.kind, target.name, frameStart, frameEnd, side ?? null]` |

Capture IDs, hashes and crop bytes stay in the raw anchor and do not enter the
logical label. This keeps wording stable when a later Apply recaptures the same
target. Consumer projection never serializes a synthetic historical act/session.

The standalone schema constants are `REVIEW_COMMENTS_SESSION_SCHEMA` =
`rig-review-session/2`, `REVIEW_COMMENTS_COMPARE_SESSION_SCHEMA` =
`rig-review-compare-session/2`, and `PARTS_COMMENTS_VERDICT_SCHEMA` =
`rig-review-parts-verdict/5`. Session/2 replaces `feedback` with `comments` and
checkpoint note entries with outcome-only entries. Compare/2 replaces `feedback`
with `comments`, requires an explicit side on Feedback anchors and checks its
existing binding hash. Parts/5 replaces `issues` with `comments`, deriving the
issue relation from Parts anchors. Other existing envelope/provenance fields
remain. `projectSelectedCommentsFeedback` selects exactly one Feedback
`anchor.id` and returns that anchor plus the scalar projection of its entry for
existing correction-writer arguments. The original new-session stdout remains
the immutable evidence.

Historical @2–@5 acts, session/1, compare-session/1, Parts/4 and survey records
stay on their original readers, raw bytes, hashes, stills and replay paths.
Display adaptation of old user feedback creates one general comment per existing
summary/note/words field, including empty strings; it never rewrites history or
reclassifies survey answers. Legacy correction summaries remain literal. Create's
old Parts names projection gives a present `issues[]` precedence even for /1-/2;
only absent `issues[]` uses `part.note`. Literal-byte controls and all eighteen
cross-repository oracle outcomes belong in the PR evidence. Parser-only native
coverage does not substitute for Create's actual ingest/replay receipt or owner
working-screen review.

### Comment context (act@7)

`JOB_COMMENT_CONTEXT_ACT_SCHEMA` is `rig-review/act@7` ([#714](https://github.com/rig-c/review/issues/714)).
It applies the @6 checks to its existing verdict, checkpoint, signoff and reopen
envelopes. Each comment entry may carry an optional `context` object after
`text` and `anchor`.
`context` records where the comment was made so opening it can restore that
view. It is not part of the signed projection: `projectComments` covers `text`
and `anchor` only. `parseContextCommentsAct` decodes @7 only; `parseCommentsAct`
still decodes @6 only and refuses `context`. @2–@6 bytes, hashes and readers do
not change.

`context` is closed and nonempty. Every key is optional and copies a value an
existing pin or restore path already carries:

| Key | Shape | Existing source |
| --- | --- | --- |
| `subject` | `{ask, sourceHash, selector?}` | the ask's `JobSubject`, the act source's `sourceHash` and `selector`. `ask.kind` must equal the act `kind`; `sourceHash` and `selector` must equal the act source (`JOB_ACT_INVALID`) |
| `mode` | `setup`, `animate` or `compare` | StageComment `mode`, bookmark `selection.mode` |
| `tab` | `view`, `rig`, `playback` or `feedback` | bookmark `selection.inspector` |
| `part` | ControlPart `{side, slot, mode, identity?}` | bookmark `selection.part` (absent, never `null`) |
| `region` | world-space `{x, y, width, height}` | StageComment `world`, PartsIssue `rigRegion` |
| `viewMode` | `item` or `assembled` | PartsIssue `view.mode` |
| `camera` | numeric camera `{space, center, zoom, viewport, visible}` | StageComment `camera` |
| `frame` | `{index, basis}` (`producer` or `reference`) | StageComment `frame` (absent when time-only) |

Each key reuses the decoder of the shape it copies. A `reopen` act is read only
(old records parse, Review neither asks nor renders it) and has no ask
subject, so its comments cannot carry `context.subject`.

Starting in 4.8.0, the rig verdict writer takes top-level `context` from pinned
stage-comment evidence and the bound ask and source. It uses @7 when at least
one comment carries that context and @6 when none does. A rig verdict carrying
mesh edits uses @8 as described below.
See [Create compatibility](STABILITY.md#mesh-edit-act-compatibility).

### Mesh edits on Request changes (act@8)

With a pending `review-verdict` ask at `stage: "rig-review"`, the existing
**Request changes** control carries pending Edit Mesh operations with any review
comments. `rig-review/act@8` extends the act@7 envelope and its validation with
optional `value.meshEdits`, permitted only for `kind: "review-verdict"`,
`stage: "rig-review"` and `verdict: "changes-requested"`. An act@8 request for
changes may have `comments: []` when it carries a mesh edit. A request with
neither a comment nor an edit refuses `JOB_ACT_INVALID`. Review emits @8 only
when it carries edits. Rig verdicts without edits keep their act@6 or act@7
format and rules. Edit Mesh remains unavailable for a `parts-verdict` subject
without a compiled rig (`PARTS_RIG_UNAVAILABLE`).

`meshEdits` is a nonempty array of exact `{edit, sha256}` objects, ordered by the
string `skin/slot/attachment` with at most one entry per `(skin, slot, attachment)`.
`JobMeshEditValue` has exactly these keys:

- `slot`, `attachment` and `skin` are nonempty strings for the edited attachment
  and its supplying table, as reported by Play's public setup identity. Linked
  meshes are ineligible for editing.
- `basis` is `"setup"`.
- `source` is exactly `{vertexCount, triangleCount, hullLength, hash, frame, positions}`.
  The whole-number counts come from the stored entry's `uvs.length / 2`,
  `triangles.length / 3` and `hull`. `hash` is 64 lowercase hex characters.
  `frame` is exactly `{width, height}`, the positive finite model stage size.
  `positions` is a dense `[number, number][]` with exactly one pair per source
  vertex, in attachment vertex order. Each pair stores the finite, unrounded
  setup position before any operation.
- `ops` contains 1 to 300 operations, replayed in order. Each operation has
  exactly the keys in its shape: `{op:"move", v, from, to}`, `{op:"add", at, onEdge?}`,
  `{op:"remove", v}`, `{op:"edge", a, b}` or `{op:"unedge", a, b}`. `v`, `a`, `b`
  and both entries of `onEdge`, when present, are nonnegative whole-number
  vertex IDs. `from`, `to` and `at` are finite `[x, y]` pairs. `from` is the
  unrounded position immediately before the move. `to` and `at` are rounded to
  0.01 px. Original IDs are attachment indices. An addition takes the next ID
  and splits `onEdge` when provided. A removed ID is never reused. `unedge` can
  remove only a constraint edge added by this edit. A vertex that ends a
  constraint edge cannot be removed.

**Coordinates and replay.** Positions use setup-pose crop pixels of the rig
canvas, with top-left origin, x right and y down. For a stage with `x = -width/2`,
`y = 0` and the drawn root at the world origin, Review maps Play's
`readSetupMesh` world coordinates to `(world.x + width/2, height - world.y)`.
Review reads setup identity from a fresh, never-played player at the model
document's setup values with no selected skin. Playback, the page's skin,
controls and other page state do not enter the setup read. The replay contract
requires undeformed setup geometry, where each displayed source vertex equals
`uv × size + origin`. Review records the displayed positions. Before any op,
Parts checks `source.frame` against its rig size and refuses a position count
that differs from its source vertex count. It compares each coordinate of
`source.positions` with its own at the same vertex index, within 0.001 crop px.
It refuses at the first vertex outside that tolerance and reports its index,
the position found and the position required. This check applies to all
edits, including edits with no `move`. The consumer can replay in either
coordinate space and can reproduce the undeformed positions without Play.

**Attachment hash and payload digest.** `source.hash` is the SHA-256 of the
UTF-8 bytes of `JSON.stringify(entry)`, where `entry` is
`skins[name=skin].attachments[slot][attachment]` in the hash-verified
`skeleton.model.json` named by the act's `source.model`. Use plain `JSON.parse`
and preserve the entry's stored key order. The producer recomputes the hash
from the model its own build writes. These are the same attachment hash bytes
used by the standalone `rig-review-mesh-edit/1` delta and draft. The `sha256`
beside each `edit` is the SHA-256 of the canonical UTF-8 JSON bytes of the
whole `edit`, including `source.positions`. Sort all object keys by UTF-16 code
units, preserve array order, omit whitespace, use `JSON.stringify` string
escaping and serialize numbers as ECMAScript `Number.prototype.toString`
shortest round-trip text. The value contains no integer-like keys, negative
zero or non-finite numbers. For this value domain the rule is RFC 8785 (JCS).

**Review refusals.** Before writing the act, Review refuses with
`JOB_ACT_INVALID` for invalid shape, digest mismatch, invalid ordering or
duplicate identity, ineligible kind, stage or verdict, counts that differ from
the stored entry, or an op that cannot replay over the stored topology. An
attachment hash that differs from the retained displayed model refuses
`JOB_ACT_SOURCE_STALE`. Existing browser `MESH_EDIT_*` refusals still apply.
Starting in 4.8.0, eligible submissions carrying edits emit act@8. Review
decoders older than 4.7.0 refuse act@8 with `JOB_ACT_INVALID`. See
[Create compatibility](STABILITY.md#mesh-edit-act-compatibility).
Review refuses `JOB_BODY_LIMIT` if the canonical UTF-8 JSON of
`value.meshEdits` exceeds 256 KiB. Rig stills and inline comment images
retain their existing request allowances. Finalized-act delivery retains its
existing limit. Review does not truncate edits.

**Consumer relay.** Create fetches the finalized act with its existing grant
and passes each `edit`, `actId`, act `source.sourceHash` and `sha256` in process
to the public Parts API. The identity for deduplication is
`(actId, skin, slot, attachment)`. Parts recomputes both hashes and refuses a
mismatch by name before any op. During replay it holds `move.from` to `1e-3`
crop px and refuses the first op that does not replay by index. The API takes
the edit and replay provenance without a Create-project argument or access
to Review or Create storage. A mesh edit
approves nothing. [HQ sign on Review #952](https://github.com/rig-c/review/issues/952#issuecomment-7001413869), [Parts #1159](https://github.com/rig-c/parts/issues/1159).

### Chest landmarks on Request changes (act@9)

The trusted package `readPublished` adapter can return
`JobPublishedContext.chestLandmarks` for a `rig` selector. Review exposes those
rows as `publication.chestLandmarks` in the publication receipt and pinned
display response. Each `JobPublishedChestLandmark` row has the edit shape below
with one additional required field, `source.configHash`, the lowercase SHA-256
of the exact producer config bytes. If the package declares a producer handoff,
Review uses that config identity. Otherwise the reader declares the config in
its existing `files` array. Review hashes the retained file and checks that
`meshes[slot].contour.bust` matches the published `bust` spec, including which
optional keys are present. Review also checks the attachment hash and stage
frame against the retained model. A bad declaration refuses
`JOB_SOURCE_MISMATCH` before publication. The seed and config hash enter the
publication's `source.sourceHash`; a config-only change gets a new binding.
Omit the field when the draft has no published spec. Only a seeded attachment
can be edited in a job.

The UI sends `value.chestLandmarks`, an array of one to four exact
`{edit, sha256}` rows. Both arrays sort by the UTF-16 string
`skin/slot/attachment` and permit each identity tuple once. Each
`JobChestLandmarkValue` edit carries:

- `slot`, `skin` and `attachment` as nonempty strings of up to 128 characters
  without control characters. These identify the supplying non-linked mesh in
  the displayed setup model. The chest carrier's slot is the Parts part name.
- `basis: "setup"` and `source: {hash, frame: {width, height}}` using the same
  attachment hash and model stage binding as act@8.
- `bust: {apex_r, apex_l, cleavage?, alpha?, clearance?, spacing?, bone_r?, bone_l?}`.
  Coordinates are finite `[x, y]` in setup-pose rig pixels, in the whole figure's
  frame with x right and y down. They lie on the 1/256-px grid inside the
  inclusive stage bounds. Alpha and spacing are positive finite numbers,
  clearance is finite, and bone names are 1–128 characters. An omitted
  cleavage stays omitted.

Each outer `sha256` hashes the complete canonical `edit` using the same
canonical JSON rules as act@8. Review validates the act shape and digest,
checks that the attachment was seeded, verifies the model and attachment
hashes, and compares the frame with the retained stage. With all three points
present, Review runs its clearance pre-check. Shape, frame, ineligible
attachment and clearance refusals use `JOB_ACT_INVALID`. A stale model or
attachment hash uses `JOB_ACT_SOURCE_STALE`. The request and delivery limits
still apply. The producer validates the edit before rebuilding.

`rig-review/act@9` is a `review-verdict` at `stage: "rig-review"` with
`verdict: "changes-requested"` and at least one chest edit. It can also carry
`meshEdits` and @7 comment context. Its comments array can be empty. Mesh-only
edits use @8, and verdicts without edits keep their existing schemas.

Consumers use the authorized finalized-act fetch and verify the act's
`source.sourceHash`, `source.model.sha256`, the attachment SHA-256 and the
frame before relaying landmarks to Parts. The publication carries the verified
config hash, and the act binds to that publication through `source.sourceHash`.
Parts checks the named slot is a contour part before writing the landmarks
file. See [Review compatibility](STABILITY.md#chest-landmark-act-compatibility)
and [Parts #1382](https://github.com/rig-c/parts/issues/1382).
