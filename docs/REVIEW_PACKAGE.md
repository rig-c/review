# Review package and existing-folder adapter v1

The toolchain delivery flow is **Parts → Pose → Core (rigc) → Review → Play →
Adapter**. Review supplies human inspection and feedback bound to the exact
reviewed sources; it neither replaces Core's build validation nor authors motion.
The app uses the published `@rig-c/play` loader/player to preview artifacts during
that inspection. This conceptual delivery order is not an import/dependency
order. Adapter means downstream consumer integration, not a newly introduced or
unreleased adapter contract. Existing producer formats and playback dependencies
remain authoritative.

The CLI also accepts an existing output directory. It reads a root `review.json` when present. Otherwise it constructs this contract in memory: optional root `skeleton.model.json`, otherwise the fixed rigc build path `build/skeleton.model.json`; read-only `skeleton.*`, `motion.json` and `report.json` links; root videos (`mp4`, `webm`, `mov`); image filenames containing strip/contact/sheet/filmstrip/띠; and canonical `*pose*.json` references. The root compiled model takes precedence over the build path. These are the only two automatically recognized model paths; discovery never searches recursively. The opened directory remains the package root, so root motion/references accompany the build model and its model-relative pages. An existing selected model with an invalid type, dangling symlink, escaping symlink or invalid model envelope is refused rather than skipped. Each reference is shown separately; no source relationship, FPS or video synchronization is inferred. It never inserts or rewrites a manifest or motion file in the source folder. Raw Spine JSON/skel remains read-only evidence with playback unavailable. The folder revision is `folder-adapter/1`; actual changed file bytes are distinguished by the source hash.

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

An optional `producer` block declares the producer handoff: `"producer": {"config": "rig/config.json", "parts": "rig/out", "source": "inputs/painting.png", "full": "inputs/full", "head": "inputs/head"}` (only `config` is required; `source` and `full` go together, `head` only with them; no other key). See *Producer handoff* below.

The illustrative `look` animation in `axes` must also be declared in `animations`. Omit axes when no real angle animation exists. All animation identifiers name actual compiled-model animations; the frontend reports runtime load/lookup errors rather than inventing them. Metadata duration is optional; the player supplies actual duration.

## Files and references

Every path is a literal relative path, including `model`, optional read-only `motion`, each reference `path`, authoring `path`, clip `path`, and every page name in the compiled model. Manifest paths accept no absolute paths, URL schemes, colon, percent encoding, traversal, backslash, query, fragment, empty segment, or symlink escape. Compiled-model page names are resolved relative to the model directory: a page such as `../parts/page.png` is accepted only when its normalized destination remains inside the review package. This permits portable local builds without letting a page escape the package. All declared files must exist as regular files. The asset endpoint serves only declared files, the manifest, and compiled-model page images. There is no arbitrary directory endpoint. Keep a package focused on the files intended for inspection.

`model` is optional and must point to `rigc-compiled/3` under a filename ending `.model.json`, produced by an upstream gated rigc build. Review uses the public `@rig-c/play` loader and player; Spine JSON/skel is not its input. Its pages are resolved relative to the model document. Missing model means unavailable playback, never a mock playback success. The runtime's optional attachment-set sidecar is not part of v1; attachment presets must remain unavailable rather than guessed.

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

`status` is `pending`, `approved`, or `changes-requested`; checkpoint `outcome` is `pending`, `pass`, or `fail`. Feedback requires an inclusive integer interval `0 <= frameStart <= frameEnd`, a target `{kind: "bone"|"slot"|"rig", name}`, `category: "defect"|"quality"`, a unique nonempty `id`, and a nonempty one-line `summary` of at most 1000 characters. `context` optionally carries inert inspection JSON (checkpoint, reference/person, time, camera/axis). Frame numbers are explicit user input; there is no guessed FPS. Unknown checkpoint IDs, mismatched content or reviewed-source bindings, duplicate feedback IDs and the old `corrections` authoring-proposal field are refused. Motion is read-only: annotations never author keys, retime output or write `motion.json`. The save does not require all checkpoints to pass: it records the person's explicit decision without manufacturing one.

### Feedback catalog and validation

`feedbackCatalog` is `{rig, bones, slots, animations, clock, clockAnimation}`. `rig` is the exact package id. `bones` and `slots` are actual model names, or null when metadata is unavailable; [] means a known empty list. `animations` is the model's `{name,duration}` list or null. Model names/durations and reviewed model identity are derived from the same exact hashed bytes; the initial page-discovery model bytes must also agree. The catalog does not certify an upstream compile gate.

New feedback requires safe integer frame indices and actual target membership. Unknown names are refused by name, such as `feedback.target.name: slot "no_such_slot" not in model`. Missing model metadata produces a named validation-unavailable refusal for bone/slot feedback. Rig feedback names the exact package id. Scan joints and point expressions are not guessed into model targets.

For a matching report/actual model animation with an explicit bounded clock, `frameEnd` cannot exceed the last declared sample at or before that model clip's end. A clip with no declared sample inside its duration has no valid feedback frames. A different animation cannot borrow the report clock; its frame bound stays unknown. Source-only explicit report clocks remain usable without inventing model animation identity. No duration/frame-count ratio or video FPS supplies a limit; unknown clocks permit manual safe integer intervals.

The server derives `context.interval:{frameStart,frameEnd,inclusive:true}` from the chosen top-level annotation. Contradictory supplied interval data is refused; optional inspection `time` and `frame` remain separate and do not replace it. Compare uses the selected side's catalog and the CLI's exact animation; a row cannot borrow another side's names or bypass the animation binding.

A single-review note also records `context.environment`, the Animate environment it was written under: `{applied, wind:{base, breeze, gust:{peak, duration, repeat, active, value}, total}, gravity, standing:{wind:[x,y], gravity:[x,y]}}`, where `standing` is what the player reported (x right, y down) and `applied:false` means the runtime start values (`wind [1, 0]`, `gravity [0, 1]`). It is `null` when no compiled model was drawn. Records without it (older sessions, compare) stay valid; a present value must have exactly this shape within the control limits. The issue export adds an `Environment:` line for it. The environment is inspection context only: it is never written to the model, the motion or any producer file.

Both session responses include server-derived `feedbackWarnings:[{id,error}]`. Reading an older session preserves invalid target rows and previously accepted integer indices outside JavaScript's safe range, together with source identity, inspection context and original state-file bytes; a missing chosen interval can be derived in memory. Contradictory existing interval evidence remains visible with its warning. The UI shows these warnings and prevents resubmission until the affected rows are corrected or removed. Strict saves independently validate every row and ignore a client's attempt to clear warnings; exports retain the warnings and original feedback evidence. Syntax and source-binding failures remain refusals rather than silently repaired data.

The state filename is a digest of identity, revision, source hash and reviewed artifact/tool identity, so package names cannot select arbitrary filesystem paths. Writes are atomic and source files remain untouched. Review/session load and save stream-hash the declared inputs; changed bytes produce HTTP 409 and require restart. Asset reads do not rehash an entire video: single byte ranges return 206 and invalid ranges 416. Asset documents receive a sandbox CSP with no scripts or same-origin permission, so delivered authoring HTML cannot approve its own package. No network listener beyond loopback or cross-origin mutation is offered.


## Feedback export

The frontend downloads `rig-review-feedback/1` JSON with `id`, `revision`, `sourceHash`, review status, `feedback[]`, and issue-ready `issues[]` entries containing title/body/labels. It also offers Markdown. Each issue contains the frame interval, target, category, summary and package binding. Exports stay local; no issue is posted automatically. These are review annotations, not motion or correction-key artifacts.


## Exact reviewed-source identity and retrieval

`reviewedSource` is server-produced and must return unchanged in submission, draft saves and exports. It contains `packageRevision` (the explicit manifest revision, or `folder-adapter/1`), `viewerVersion` (this app's package version), `runtimeVersion` (the installed `@rig-c/play` package version), and `rig`/`motion`, each null or `{path,sha256}` for the exact reviewed file bytes. No producer version is inferred from a report's generic version field.

The active compiled model supplies rig identity. Without one, a known root or uniquely declared authoring `skeleton.json`/`skeleton.skel` supplies raw evidence identity, still with playback unavailable. Motion identity comes from optional explicit `motion`, an actual root `motion.json`, or a uniquely declared authoring `motion.json`; no missing file receives a guessed hash. These known identity files join the source-hash/asset allowlist. Differently named motion sources require the explicit `motion` path. Each hash is streamed from exact bytes alongside the package hash. Submissions reject altered identity and revalidate current source before saving.

`bun run feedback -- <review.json|output-directory>` reads the existing bound session JSON after the UI closes. With no saved state it emits pending and `updatedAt: null`. It never writes source or creates a review submission. JSON/Markdown exports include this identity, so another agent can tell exactly which rig, motion and viewer revision a person reviewed.


## Producer handoff

An Apply rebuilds through the installed producer from the files the inspected rig was built from: the producer config, its parts directory (`parts.json`, `parts/`) and the inspected rig directory `<parts>/rig/`. Review finds them in this order, first match wins, never by searching:

1. **Declared on the command line**: `rig-review open <dir> --config <path> [--parts <dir>] [--source <png> --full <dir> [--head <dir>]]`. `feedback` and `control` take the same flags so retrieval binds the same identity. Paths are resolved from the working directory and canonicalized; the worker and every reload read exactly those files.
2. **Declared in review.json**: the `producer` block, package-relative literal portable paths (no `..`, no absolute path, no encoding).
3. **Discovered inside the opened folder**: `config.json`, then `rig/config.json`.
4. **Discovered beside an opened `out/`** (the last step): `../config.json`. It is outside the opened folder, so the record says `"how": "discovered", "outside": true` and the editor bar says *discovered outside the opened folder*, with its path and SHA-256. This step runs only when the opened folder is named `out`, and only for a regular file there (a symlink is refused).

Without `--parts` the parts directory is `out/` beside the config (for step 4, the opened `out/` itself). A declared or discovered path that is missing, outside its root (the package root; for step 4 the folder holding `out/`), or a symlink that leaves it is refused by name: `HANDOFF_PATH_OUTSIDE_ROOT`, `HANDOFF_SYMLINK_ESCAPE`, `HANDOFF_INPUT_MISSING`, `HANDOFF_INPUT_INVALID`, `HANDOFF_PATH_INVALID` (`open` prefixes `OPEN_HANDOFF_INVALID <flag or path>`). Nothing found is not a load error: `/api/rebuild` reports `MODELING_INPUT_UNAVAILABLE: config.json — looked at config.json, rig/config.json, ../config.json (beside an opened out/); declare it with rig-review open <dir> --config <path> [--parts <dir>] or the review.json "producer" block`, and Apply refuses `MODELING_HANDOFF_MISSING`.

**Hashed files.** The config; the files the config names that the producer resolves against the config's directory (`motion.animations_from`, `generation.control.skeleton`; each must stay inside the root, a missing one is listed in `missing`); `parts.json` and every regular file directly in `parts/`; every regular file directly in the inspected `rig/` (`rig.json`, `motion.json`, `mesh_report.json`, `sets.json`, …) and `rig/images/`; with `--source`/`--full`/`--head`, that PNG and the regular files directly in those directories.

**Record and identity.** `reviewedSource.handoff` (absent when there is no handoff, so earlier identities are unchanged):

```json
{"schema":"rig-review-handoff/1","how":"discovered","via":"discovery","outside":false,
 "config":{"path":"rig/config.json","sha256":"…"},"parts":"rig/out","rig":"rig/out/rig","source":null,"full":null,"head":null,
 "files":[{"path":"rig/config.json","sha256":"…"},{"path":"rig/out/parts.json","sha256":"…"}],"missing":[]}
```

`how` is `declared` or `discovered`, `via` is `open --config`, `review.json producer` or `discovery`, and paths are relative to the package root (`../` only for step 4). The record is part of `reviewedSource`, so it reaches `/api/review`, the session, the feedback export and the session file name: changing any handoff file's bytes starts a new pending session while `sourceHash` (the package bytes) is unchanged, and the open-managed key changes with it. The same inputs give the same record, key and URL.

**Baseline.** See README, *Chest regions*: once per session `rig-parts rig --config --parts --out <state>/baseline/<key>/baseline`, compared file by file with the inspected rig; `/api/rebuild` returns `baseline` (`status` `running`, `reproduced`, `not-reproduced`, `refused` or `failed`, `firstDifference`, both rig.json and tree hashes, `wallMs`). Nothing is written into the package. Once the baseline reproduces, `rig-parts check --rig baseline --out inspected-check --parts <parts> --page-edges free --pack-shape polygon` runs in the background in the same directory, and `/api/rebuild` returns `inspectedCheck` (`{schema:"rig-review-inspected-check/1", key, status:"running"|"checked"|"refused"|"failed", lines[], check (the check summary, or null), line ("check running…", check's `check: …` line, or its named refusal verbatim), exitCode, wallMs}`, else `null`). The finished record is stored as `<state>/baseline/<key>/inspected-check.json`, so a reopen reads it instead of re-running; it is the physics readout's BEFORE for the inspected build.

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
- **Refusals before anything runs.** Malformed (HTTP 400): `EDIT_PATCH_INVALID`, `EDIT_PATCH_OP_UNKNOWN`, `EDIT_PATCH_POINTER_INVALID`, `EDIT_PATCH_CMD_UNKNOWN`, `EDIT_PATCH_ARG_UNKNOWN`. Outcomes (HTTP 200, `{status:"refused", error, producerLine:null}`): `EDIT_PATCH_STALE` when `config_sha256` is not the handoff config's hash; `EDIT_PATCH_PATH_MISSING` when a pointer does not resolve in that config; `EDIT_PATCH_NAME_MISMATCH` when an op's `name` is not the name its index holds there; `EDIT_PATCH_PATH_HELD` when the patch changes a file name the config resolves against its directory (`motion.animations_from`, `generation.control.skeleton` — handoff files); `EDIT_PATCH_OUT_OF_SCOPE` when a `remesh` patch edits outside `/meshes/<part>`; `EDIT_PRODUCER_MISMATCH` when the installed producer is not the patch's; for `rig`, `EDIT_BASELINE_MISMATCH: <first differing path>` unless the session's baseline reproduced the inspected rig (*Producer handoff*, Baseline); and the producer-resolution refusals of an Apply.
- **Run.** Scratch is `<state>/rebuild/<package source hash>/<id>/`, `id = sha256([rig-review-rebuild/1, "patch", source hash, config SHA-256, the patch's canonical bytes, producer@version, compiler@version])` — no clock; the same patch again reuses its build. `rig`: `config.json` there is the patched config written as the producer's own scratch configs are (2-space JSON, `motion.animations_from` and `generation.control.skeleton` made absolute when they name a file beside the handoff config), then `rig-parts rig --config config.json --parts <handoff parts> --out rig [args]`. `remesh`: `mesh.json` is the patched `meshes.<part>` entry and `rig-parts remesh --rig <handoff rig> --config <handoff config> --parts <handoff parts> --part <part> --mesh mesh.json --out rig [args]` (remesh reads the config as written). Then `rigc build --rig rig/rig.json --motion rig/motion.json --out build --profile rig-play --pack --page-edges … --pack-shape …` (the args' values, else `free` / `polygon`; for remesh, its `remesh.json` request) and `rig-parts check --rig rig --out check --parts <handoff parts>` with the same pack flags. A producer or compiler refusal is the first named line verbatim and leaves no scratch; a check `FAIL` is check's judgment, kept beside the build.
- **Request and job.** `POST /api/rebuild` takes exactly `{patch}` (or #99's `{part, regions, configHash}`, or #105's `{part, bust, configHash}` — see *Chest landmarks* below), same-origin, 64 KiB. The job (`GET /api/rebuild/<id>`): `{schema:"rig-review-rebuild/1", kind:"patch", id, status:"running"|"built"|"refused"|"failed", reused, request:{patch, patchSha256, configHash}, producer, compiler, lines[], producerLine, exitCode, wallMs:{op, compile, check}, check, diff:{count, paths[≤200]}, build:{model, modelUrl, modelHash, files}|null}`. `diff` lists every JSON Pointer at which the scratch `rig.json` differs from the inspected one (a changed leaf or type, a key or index only one side has). `check` is `{schema:"rig-review-check-summary/1", pass (check.json's PASS, or null without one), exitCode, line (check's last `check: …` line, or its first named refusal), bars:{NAME: status}, gate}`.

**`context.applied`.** Feedback written while a scratch build is on the stage carries the applied state; otherwise `null`. Absent and `null` stay valid, and a present value must be exactly one of:

- `rig-review-applied/1` (#99 regions): `{schema, buildId, part, regions, configHash, entrySha256, producer, compiler, line, modelHash}`; a Landmarks Apply (#105) adds `bust` (the `contour.bust` entry as sent) and its `regions` are review's derivation of the two circles.
- `rig-review-applied/2` (patch): `{schema, buildId, patch, patchSha256, configHash, producer:{package,version}, compiler:{package,version}, line, check, diff, modelHash}` — the exact patch (whose `config_sha256` equals `configHash`), its hash, the producer's last line, check's summary and the rig.json diff. A remesh patch from the Mesh panel (#106) adds `mesh: {part, before:{vertices, triangles, hull}, after:{vertices, triangles, hull}}` — the revision's `remesh.json` counts; `part` must be the part the patch's `remesh --part` names. Since #125 the record adds `files: {documents:[{file, count, paths}], images:{changed, unchanged, names}}` (or `null`) — the scratch rig against the inspected rig, every document the producer writes: `documents` in the order `rig.json`, `motion.json`, `sets.json`, `mesh_report.json` (each `file` at most once; a document neither side has is left out), `count` the number of RFC 6901 pointers at which it differs and `paths` the first ≤ 200 of them (`""` — the whole document — when only one side has it or a side is not JSON, unless the bytes are equal); `images` compares `images/*` by SHA-256 only: `changed` (including an image only one side has, its `images/<name>` in `names`, ≤ 200) and `unchanged`. `diff` stays rig.json's entry as before. Records without `files` (written before #125) stay valid. The list of documents is `PRODUCER_DOCUMENTS` in `src/producer-files.ts`, the same list the baseline compares. The Apply status line and the export state it per file: `motion.json differs at 2 path(s) · rig.json, sets.json, mesh_report.json unchanged · 31 images unchanged`.

**Readings (#108).** `POST /api/readings` (single review; same-origin, capability, 16 KiB) takes exactly `{animation, readings:[1–8], environment}`: each reading is `{kind:"folds"}`, `{kind:"overlaps"}`, `{kind:"pass-through", cloth, leg}`, `{kind:"seam", a, b}` or `{kind:"angle-range", bone, relative}`, every name a slot or bone name without `:` or `,` (whether the rig has it is rigc's to say), no reading twice; `environment` is `null` or `{wind:[x,y], gravity:[x,y]}` (x right, y down). Malformed: HTTP 400 `READINGS_REQUEST_INVALID`. Outcomes (HTTP 200 `{status:"refused", error}`): `READINGS_COMPILER_NOT_INSTALLED` (rig-c beside `@rig-c/parts`, else beside the package or review), `READINGS_COMPILER_TOO_OLD <found> 2.63.0`, `READINGS_NO_MODEL`, `READINGS_STATE_INSIDE_PACKAGE`, `READINGS_BUSY`. The job (`GET /api/readings/<id>`, the id hashed from the package, the request, the inspected model's bytes, the scratch build id, the compiler and whether the schedule was passed): `{schema:"rig-review-readings/1", id, status:"running"|"done"|"failed", error, request, environment:{requested, flag, passed}, compiler, runs:[{build:"inspected"|"scratch", id, modelHash, results[]}]}`. Each result is `{reading, label, status:"read"|"refused"|"failed", fps, frames[] (every frame the reading's JSON lists: folds' meshes' frames, pass-through's frames, seam's opens, overlaps' moving pairs' runs; angle-range's lowest and highest frame from its printed line), source:"json"|"line", worst:{frame, figure, line}|null, items[] (per mesh or pair), lines[] (rigc's printed rows for the reading), refusal (rigc's `rigc: …` line verbatim), exitCode, wallMs}`. The inspected build is `--candidate <the directory of the manifest's model>`; the scratch build is the session's latest built Apply. Each reading runs as `rigc render --candidate <build> --animation <animation> [--environment environment.json] <flag> --out render` in `<state>/readings/<package hash>/<inspected-<model sha256>|scratch-<build id>>/<key>/`, keeps `result.json`, the reading's JSON and `frames.json`, and removes the rendered frames. The schedule `{spec:"rigc-environment/1", steps:[{t:0, wind, gravity}]}` is passed only when `rigc render --help` lists `--environment`.

**`context.readings`.** Feedback written after a readings run carries the pairs of the last finished run: `{schema:"rig-review-readings/1", animation, requests[] (the readings as sent), environment, environmentPassed, builds:{inspected:<model sha256>, scratch:<build id>|null}, compiler:{package, version}, ticks:{inspected, scratch|null}}`; `null` when none ran. Absent and `null` stay valid; a present value must have this shape. The results themselves are not recorded: the AI receiving the review reruns the same `rigc render` readings on the named builds.

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

**Idle tracks (#104).** `GET /api/rebuild` also returns `idle` (or `null` without a handoff): `{source, keying}`. `source` is `{available:true, source:{duration, tracks[], blink|null, bones[], chains:{<chain>: <links>}}}` — `config.motion` read for its shapes only (a single track `{bone, prop, amp, period, phase, base?}`, `prop` one of rig-parts' `rotate translatex translatey scalex scaley shearx sheary`; a chain track `{chain, amps[], period, phase, lag}`; the blink as written), the bones `config.bones` declares with chain links expanded (`<chain>0…`) — or `{available:false, reason:"IDLE_TRACKS_UNAVAILABLE: …"}`. `keying` says where the inspected idle keys each track, read off the handoff rig's `rig.json` and `motion.json`: `{keys:"ctl"|"direct", source, keyed:{"<config bone>.<prop>": "<keyed bone>"}, controls[]}` (`direct` when `rig.json` declares `invariants.idleDrivesMeshes`, which `rig --idle-keys direct` writes; otherwise `ctl`, the producer's default, under which a keyed bone a mesh is weighted to is keyed on `<bone>_ctl`), or `{error:"IDLE_KEYS_UNKNOWN: …"}`. The panel's edits are ordinary config patch ops: field ops at `/motion/tracks/<i>/<field>` (and `/motion/tracks/<i>/amps/<k>` for one chain link) on the config's own indices, then removed tracks as `remove /motion/tracks/<i>` from the highest index down, then added tracks as `add /motion/tracks/-`, then `/motion/blink/<field>`; Apply sends them as one `rig` patch with `--idle-keys <keying.keys>` (no flag when the keying could not be read). The local draft's `#idle-pending` record is `{schema:"rig-review-idle-draft/1", ops}` and is restored only when the ops are exactly the ones the panel writes for the idle they describe. The preview is page state only: it is in neither the draft, the patch nor `context.applied`.

The issue export adds an `Applied:` line for a valid record (`patch <hash>… (rig; replace /constraints/0/damping) with @rig-c/parts 1.42.0 · check PASS · rig.json differs at 1 path(s) · motion.json, sets.json, mesh_report.json unchanged · 31 images unchanged · model <hash>…`; a record without `files` says `rig.json differs at N path(s)` alone); the raw context follows it. The review's `reviewedSource` still names the inspected build.

**Bones (#109).** `GET /api/rebuild` also returns `bones`: the handoff config's `bones` list as written (or `null` without a handoff). The Bones block's edits are ordinary config patch ops, `{op:"replace", path, value:[x, y], name}` with `path` one of `/bones/<i>/at`, `/bones/<i>/points/<k>`, `/bones/<i>/tip` (rig px) and `name` the entry's `name` — a chain entry, which has none, is named by its `chain`, and `EDIT_PATCH_NAME_MISMATCH` checks it the same way. Apply sends them as one `rig` patch (no flag), so it needs the reproduced baseline. `POST /api/bones-check` (single review; same-origin, capability, 64 KiB) takes exactly `{ops, configHash}`; every op must be such a `replace` (anything else is HTTP 400 `BONES_OP_OUT_OF_SCOPE`), and the patch refusals apply (`EDIT_PATCH_STALE`, `EDIT_PATCH_NAME_MISMATCH`, `EDIT_PATCH_PATH_MISSING`, `EDIT_PATCH_PATH_HELD`; producer resolution refusals verbatim; `BONES_CHECK_BUSY`), as HTTP 200 `{status:"refused", error}`. It writes the patched config (`scratchConfigText`) to `<state>/bones-check/<package hash>/<ops hash>/config.json`, runs `rig-parts propose --parts <handoff parts> --source <handoff source> --out propose --from-config config.json` and `rig-parts compare --left <handoff config> --right config.json` there, removes the directory, and returns `{schema:"rig-review-bones-check/1", status:"checked", request:{configHash, opsSha256, ops}, producer, propose:{status:"ran"|"unavailable", exitCode, wallMs, lint[], summary, coverage[], line}, compare:{exitCode, wallMs, origins:[{bone, distance|null, tip|null, text}], summary[], line}}`. `propose.line` is the LINT count line, propose's named refusal when it exits non-zero without a LINT line, or — when the handoff declares no source painting — `MODELING_INPUT_UNAVAILABLE: source painting — propose --from-config reads the painting (--source) and the handoff declares none; declare it with rig-review open <dir> --config <path> --source <png> --full <dir> or the review.json "producer" block`. Nothing is written into the package.

**Rig fields (#110).** `GET /api/rebuild` also returns `fields`: the handoff config's `regions`, `motion.blink` (as `{motion:{blink}}`), `stops`, `bones` and `turn` as written, an absent section left out (or `null` without a handoff). The Rig fields block's edits are ordinary config patch ops, each at its field's pointer (rig-parts AUTHORING §3): `{op:"replace", path:"/regions/<part>", value:<bone>}`; `{op:"add", path:"/motion/blink/still/<part>", value:{row, bone}}` (preceded by `{op:"add", path:"/motion/blink/still", value:{}}` when the config states no `still`) or `{op:"remove", path:"/motion/blink/still/<part>"}`; `{op:"replace", path:"/stops/<i>", value:<the entry with inward / outward changed>, name:<its chain>}`; `{op:"add"|"remove", path:"/bones/<i>/inherit", value:<mode>, name}` or `path:"/bones/<i>/link_inherit", value:{<link>: mode}`; `{op:"replace", path:"/turn/pivot"|"/turn/depths/<part>", value:<number>}`. A `stops` entry is named by its `chain` and `EDIT_PATCH_NAME_MISMATCH` checks it as it checks a `bones` entry. The page refuses anything else before sending (`RIG_FIELDS_OP_OUT_OF_SCOPE`; `turn.deform` is out of scope) and sends the ops as one `rig` patch (no flag), so it needs the reproduced baseline; there is no `retune` op in rig-parts yet. The producer judges every value and its refusal comes back verbatim as the job's `producerLine`. The turn dial is play's `adjust` on the drawn build's `turn` bone; it is not a patch op and nothing records it. Nothing is written into the package.

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

- **Space.** Every position is a setup-pose crop pixel of the rig canvas, x right, y down: the attachment's stored vertices in the compiled model document (`skeleton.model.json`), placed through the setup-pose bones and mapped by the model stage (`world = (x − width/2, height − y)`, root at the world origin). `basis` is always `"setup"`; the producer refuses any other basis (`REMESH_DELTA_BASIS`). A package without the model document has no setup mesh: Edit Mesh refuses `MESH_EDIT_MODEL_UNAVAILABLE` and exports nothing.
- **Source.** `vertexCount`, `triangleCount` and `hullLength` are the stored entry's (`uvs`/`vertices`, `triangles`, `hull`; the first `hull` vertices, in order, are the outline). `hash` is the SHA-256 of `JSON.stringify` of the attachment's entry (`skins[name].attachments.<slot>.<attachment>`) in the hash-verified model document. The producer holds both to the input part's own (`REMESH_DELTA_SOURCE`) and requires `skin` `"default"` with `slot` and `attachment` the part's name. A linked mesh is not editable (edit its source).
- **Ops**, in order, at most 300: `move {v, from, to}` — `from` is the vertex's exact current position, unrounded (the producer refuses a `from` more than 1e-3 px off), `to` rounded to 0.01 px; `add {at, onEdge?}` — the next id, splitting edge `onEdge` when given; `remove {v}` — the vertex and its triangulation edges, never a vertex that ends a constraint edge; `edge {a, b}` — a constraint edge; `unedge {a, b}` — only a constraint edge this delta added (hull and triangulation edges are the producer's; review refuses `MESH_EDIT_HULL_EDGE`, `MESH_EDIT_TRIANGULATION_EDGE` and `MESH_EDIT_CONSTRAINT_END` before recording). Vertex ids are the attachment's indices; an added vertex takes the next id; a removed id is never reused. Each op carries exactly these keys.
- `units` and `preview` are text for a reader; nothing reads them.

`mesh-edit.binding.json` (`rig-review-mesh-edit-binding/1`) binds the delta: `file {name, sha256}`, the package source hash, the model and motion SHA-256, `attachment {slot, skin, name, sha256}` (the same `hash`), `exportedAt`, the viewer and runtime versions, `mapping` (the crop mapping's basis) and an evidence note. Apply · Rebuild does not send the delta yet; it refuses `MODELING_TARGET_UNSUPPORTED` by name.

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

For a legacy report with no declared full clock, frame-only markers remain visible with feedback frame prefills and unavailable seek; switch/from and uncovered/times can seek. Producer timing additions are tracked in [rig-c/pose #209](https://github.com/rig-c/pose/issues/209). Selecting a marker preloads only supplied frame coordinates and actual target choices. It neither guesses FPS nor maps scan joints to rig bones, and report measurements do not automatically mark a defect, category, checkpoint result or overall approval.


## Producer-frame transport

This unit accepts a clock only from the recognized source-bound report, not from a manifest or video metadata. `/api/review.report.clock` is null when absent, or one of:

```json
{"kind":"uniform","fps":24,"frame0":0,"frameCount":313}
{"kind":"samples","frameTimes":[1,1.08,1.41,2.9]}
```

The uniform example is an explicitly authored test clock; it is not a timing claim about the unchanged v19 report. `fps` is positive, `frame0` is a required offset in seconds, and frame `n` occurs at `frame0 + n / fps`. The declared uniform step must conservatively exceed floating-point resolution across its domain; numerically collapsed sample clocks fail by name rather than mapping two frame indices to one time. `frameCount` comes only from report `frames`; omitted frame count leaves uniform metadata unbounded and does not enable frame transport. The samples variant carries each exact producer timestamp, so its length supplies the last frame even without a separate count. No interpolation is performed.

The current frame is the greatest sample index whose timestamp is at or before the inspection time, only within the closed interval from the first sample to the last. Time before or after that domain is unknown; the last frame has no invented trailing duration. A one-frame clock is known only at its single timestamp, and an empty clock is unknown. Frame seeking accepts only a nonnegative integer through the declared last index and returns that sample's exact time. Broad epsilon snapping does not advance a genuinely earlier time to the next frame.

With a model player, the transport uses this clock only while the active animation exactly matches the report's named `animation`; other animations or a missing binding keep frame lookup unknown. A source-only inspection can use its explicit report clock without inventing an animation identity. Unbounded or absent timing keeps frame lookup unknown. The seconds transport remains available independently. Bounded clocks show `F<n> / <last>`; outside their domain the frame is unknown. The unchanged v19 report displays `rate unknown`. An explicit 24fps, zero-offset test fixture shows F100 at `100/24`, displayed as 4.1667s; offset and irregular fixtures exercise the different declared times.

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

Each interval has its own source-row grid; overlapping groups preserve their feedback ids and repeated frames. Source packages and reference are checked before and after export, including exact model/page/motion bytes through existing package hashes. The PNG footer includes full rig/motion hashes (null stays absent), revisions, viewer/runtime and actual renderer versions. Exports are derived evidence, never a new source or approval. CLI destinations and `.json` sidecars must be new files outside both source roots; parent symlinks and existing targets are refused. Downloads have no arbitrary filesystem destination parameter.

The pure layout reserves a maximum `footerHeight` budget for complete provenance. The native renderer wraps the actual footer text before allocation and uses only that measured height; `rendering.width/height` records the actual PNG extent. Unsupported RGB/dark tint refuses by name (`STRIP_UNSUPPORTED_TINT`) rather than claiming Canvas2D pixel parity for features its published renderer omits.

A strip plan with one clock basis reports `plan.basis:"single"|"a"|"b"`. A comparison batch containing both sides reports `plan.basis:"mixed"`; each group still carries its own `basis` and its own report-derived sample times. Consumers must use the group basis for a mixed plan rather than treating the first group as a batch-wide clock. The selected basis row labels requested producer frames/times; actual PTS and independently calculated actual frames remain separate rendering metadata. Output containment and every parent-directory check use native platform separators, including Windows drive and UNC paths.

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
instance identity. Existing foreground servers do not gain an open registration
or browser filesystem API.

Registry/request/log/claim files are private tool-state files; a per-binding claim
serializes startup, stale records are not reused, and no unrelated process is
terminated. Workers expire after 30 minutes without requests and clean only their
own nonce's registration. Startup waiting is bounded. `RIG_REVIEW_STATE_DIR`
changes the tool state root but cannot place it inside a source package, including
through a symlink alias. No package manifest, source video, motion or compiled
model is written by open. There is no browser launch or new LAN exposure.

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
this checkout consumes pinned 1.11.2. The consumer does not probe GL or inspect
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
synchronized or independent per-pane cameras, animation/time, playback/idle-loop,
layers, readiness/feedback eligibility and supported capabilities. Unavailable
capabilities stay false; absence does not manufacture a model or frame clock.

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
