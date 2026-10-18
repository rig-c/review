# Review package and existing-folder adapter v1

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

The illustrative `look` animation in `axes` must also be declared in `animations`. Omit axes when no real angle animation exists. All animation identifiers name actual compiled-model animations; the frontend reports runtime load/lookup errors rather than inventing them. Metadata duration is optional; the player supplies actual duration.

## Files and references

Every path is a literal relative path, including `model`, optional read-only `motion`, each reference `path`, authoring `path`, clip `path`, and every page name in the compiled model. Manifest paths accept no absolute paths, URL schemes, colon, percent encoding, traversal, backslash, query, fragment, empty segment, or symlink escape. Compiled-model page names are resolved relative to the model directory: a page such as `../parts/page.png` is accepted only when its normalized destination remains inside the review package. This permits portable local builds without letting a page escape the package. All declared files must exist as regular files. The asset endpoint serves only declared files, the manifest, and compiled-model page images. There is no arbitrary directory endpoint. Keep a package focused on the files intended for inspection.

`model` is optional and must point to `rigc-compiled/3` under a filename ending `.model.json`, produced by an upstream gated rigc build. Review uses the public `@rig-c/play` loader and player; Spine JSON/skel is not its input. Its pages are resolved relative to the model document. Missing model means unavailable playback, never a mock playback success. The runtime's optional attachment-set sidecar is not part of v1; attachment presets must remain unavailable rather than guessed.

Reference `type` is `image`, `video`, or `pose`. `width` and `height` optionally state image pixel dimensions. The primary animated pose input is Nova/@rig-c/pose's canonical `rig-pose-sequence/1`, consumed directly:

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

A checkpoint requires `id` and `title`. Optional `workspace` is `modeling` or `motion`; `animation` names a declared animation; `reference` names a declared reference; `time` is finite seconds >= 0; `note` provides inspection guidance. Optional `camera: {zoom,x,y}` states a positive scale relative to fit and a center in model world coordinates (Y up). Optional `axis: {id,value}` names a declared axis and a finite value inside its min…max range; it is applied after the checkpoint time. The checkpoint URL is `/?checkpoint=<encoded id>`; reopening it restores the declared time, camera and workspace, not an approval.

An optional axis declares `id`, `label`, `animation`, finite `min` and `max` with `min < max`. It maps the scalar range linearly to that animation's 0…runtime duration for inspection. Only one axis is applied at a time; composite angle blending is not claimed.

Audio clips contain `id`, local `path` and optional `label`. Cues require `id`, a declared `clip`, absolute output `time` in seconds >= 0, and optional declared `animation`. Cues provide audition/synchronization evidence only. This release does not edit source audio, infer phonemes, guarantee sample-accurate playback, or author timeline keys.

## HTTP contract

- `GET /api/review` returns `{manifest, sourceHash, reviewedSource, report, assetsBase:"/assets/", capabilities}`. `report` is the normalized read-only finding data described below, or null. `capabilities` is `{playback:boolean, modeling:false, motion:false, feedback:true, audio:true}`. The modeling/motion flags mean source editing capability; the workspaces themselves remain available. `audio:true` denotes the audition facility; clip presence determines what can play.
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
  "feedback":[{"id":"note-1","frameStart":10,"frameEnd":18,"target":{"kind":"bone","name":"arm"},"category":"defect","summary":"Elbow snaps during the turn","context":{"checkpoint":"silhouette"}}],
  "updatedAt":null
}
```

`status` is `pending`, `approved`, or `changes-requested`; checkpoint `outcome` is `pending`, `pass`, or `fail`. Feedback requires an inclusive integer interval `0 <= frameStart <= frameEnd`, a target `{kind: "bone"|"slot"|"rig", name}`, `category: "defect"|"quality"`, a unique nonempty `id`, and a nonempty one-line `summary` of at most 1000 characters. `context` optionally carries inert inspection JSON (checkpoint, reference/person, time, camera/axis). Frame numbers are explicit user input; there is no guessed FPS. Unknown checkpoint IDs, mismatched content or reviewed-source bindings, duplicate feedback IDs and the old `corrections` authoring-proposal field are refused. Motion is read-only: annotations never author keys, retime output or write `motion.json`. The save does not require all checkpoints to pass: it records the person's explicit decision without manufacturing one.

The state filename is a digest of identity, revision, source hash and reviewed artifact/tool identity, so package names cannot select arbitrary filesystem paths. Writes are atomic and source files remain untouched. Review/session load and save stream-hash the declared inputs; changed bytes produce HTTP 409 and require restart. Asset reads do not rehash an entire video: single byte ranges return 206 and invalid ranges 416. Asset documents receive a sandbox CSP with no scripts or same-origin permission, so delivered authoring HTML cannot approve its own package. No network listener beyond loopback or cross-origin mutation is offered.


## Feedback export

The frontend downloads `rig-review-feedback/1` JSON with `id`, `revision`, `sourceHash`, review status, `feedback[]`, and issue-ready `issues[]` entries containing title/body/labels. It also offers Markdown. Each issue contains the frame interval, target, category, summary and package binding. Exports stay local; no issue is posted automatically. These are review annotations, not motion or correction-key artifacts.


## Exact reviewed-source identity and retrieval

`reviewedSource` is server-produced and must return unchanged in submission, draft saves and exports. It contains `packageRevision` (the explicit manifest revision, or `folder-adapter/1`), `viewerVersion` (this app's package version), `runtimeVersion` (the installed `@rig-c/play` package version), and `rig`/`motion`, each null or `{path,sha256}` for the exact reviewed file bytes. No producer version is inferred from a report's generic version field.

The active compiled model supplies rig identity. Without one, a known root or uniquely declared authoring `skeleton.json`/`skeleton.skel` supplies raw evidence identity, still with playback unavailable. Motion identity comes from optional explicit `motion`, an actual root `motion.json`, or a uniquely declared authoring `motion.json`; no missing file receives a guessed hash. These known identity files join the source-hash/asset allowlist. Differently named motion sources require the explicit `motion` path. Each hash is streamed from exact bytes alongside the package hash. Submissions reject altered identity and revalidate current source before saving.

`bun run feedback -- <review.json|output-directory>` reads the existing bound session JSON after the UI closes. With no saved state it emits pending and `updatedAt: null`. It never writes source or creates a review submission. JSON/Markdown exports include this identity, so another agent can tell exactly which rig, motion and viewer revision a person reviewed.


## Read-only rig-pose report markers

A folder's root `report.json`, or a unique declared authoring file named `report.json`, is read only and remains part of the exact input hash. A JSON object with `spec: "rig-pose-report/1"` supplies normalized findings under `/api/review.report`; unrelated report objects remain evidence and supply null. An explicit manifest does not discover an undeclared report. Recognized malformed values fail by source field name. No report is rewritten and selecting a finding never submits a review.

The supported categories are `switches`, `raised`, `short`, `endOn`, `cleaned.holds`, `cleaned.seams`, `feet.jumps`, `feet.supports`, `landings`, `shear`, `artRange`, `uncovered`, `flips`, `turns`, `range`, and `holds`. Missing fields supply no category or synthetic marker. A supplied empty array supplies `{field, state:"empty", events:[]}` so the UI can show none. A null optional parent such as `feet` supplies no child categories. Top-level `holds` and `cleaned.holds` are different lists.

`report` contains `spec`, source `path`, optional producer `animation`, `rig`, `frameCount`, `durationSeconds`, optional frame metadata, nullable `clock`, and `categories: [{field,state,events}]`. Each event contains a stable `id`, source `{path,pointer}` (a JSON pointer), `field`, original `details`, actual named bone/slot `targets`, separate scan/chain/side `provenance`, and timing state. A source single `frame` normalizes to inclusive `frames:[n,n]`; a source `frames:[first,last]` retains both indices. Legacy top-level holds use `from/to` as frame indices. These indices are never derived from seconds. `joint`, `point`, `joints`, `chain`, `chains`, `side`, `set`, `attachment`, and `line` remain provenance; none implies a rig bone. Switch `slots` keys are actual slot names and multiple targets remain selectable rather than choosing one by heuristic.

Timing is deliberately explicit:

- `seek:{time,source}` appears only with an event `t`, event `times`, switch `from`, an exact indexed root `frameTimes[]`, or the complete root pair `fps` and `frame0`. Uniform timing follows the producer contract `t = frame0 + frame / fps`: `frame0` is an offset in seconds, never an assumed zero. `frameTimes` are strictly increasing seconds, one per reported frame when the frame count is present, with no interpolation. Contradictory event and clock times are refused within a 1e-6 tolerance. If both root time-base forms are provided they must agree.
- Switch `timeInterval:{start,end,endKind:"boundary"}` preserves `from/to`: `to` is the boundary where the base art returns, not an invented last-frame timestamp. Explicit event `times:[first,last]` or a mapped frame interval uses `endKind:"frame"`.
- `uncovered.times[]` remains a discrete list of seconds, including every gap. It receives no invented frame interval or continuous time span. Its first explicit time is the default seek; each provided time remains selectable.
- Legacy `seconds` and optional `spanSeconds` are durations only, normalized as `durationSeconds`. Neither starts a seek. `frames` plus overall `duration` never implies FPS; unrelated event samples do not establish a clock for other events.
- `timing:"mapped"` means an explicit seek is available; `"frames-unmapped"` retains source frame coordinates but displays **시간 맵 없음 — seek 불가**. `"unavailable"` denotes an entry with no usable seek or frame coordinate (for example a provided empty discrete time list). No missing time receives zero.

The existing dancer v19 report has no declared full clock. Its frame-only markers remain visible with feedback frame prefills and unavailable seek; switch/from and uncovered/times can seek. Producer timing additions are tracked in [rig-c/pose #209](https://github.com/rig-c/pose/issues/209). Selecting a marker preloads only supplied frame coordinates and actual target choices. It neither guesses FPS nor maps scan joints to rig bones, and report measurements do not automatically mark a defect, category, checkpoint result or overall approval.


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
