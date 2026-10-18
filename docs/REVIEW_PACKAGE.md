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

- `GET /api/review` returns `{manifest, sourceHash, reviewedSource, report, feedbackCatalog, assetsBase:"/assets/", capabilities}`. `report` is the normalized read-only finding data described below, or null. `capabilities` is `{playback:boolean, modeling:false, motion:false, feedback:true, audio:true}`. The modeling/motion flags mean source editing capability; the workspaces themselves remain available. `audio:true` denotes the audition facility; clip presence determines what can play.
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

Both session responses include server-derived `feedbackWarnings:[{id,error}]`. Reading an older session preserves invalid target rows and previously accepted integer indices outside JavaScript's safe range, together with source identity, inspection context and original state-file bytes; a missing chosen interval can be derived in memory. Contradictory existing interval evidence remains visible with its warning. The UI shows these warnings and prevents resubmission until the affected rows are corrected or removed. Strict saves independently validate every row and ignore a client's attempt to clear warnings; exports retain the warnings and original feedback evidence. Syntax and source-binding failures remain refusals rather than silently repaired data.

The state filename is a digest of identity, revision, source hash and reviewed artifact/tool identity, so package names cannot select arbitrary filesystem paths. Writes are atomic and source files remain untouched. Review/session load and save stream-hash the declared inputs; changed bytes produce HTTP 409 and require restart. Asset reads do not rehash an entire video: single byte ranges return 206 and invalid ranges 416. Asset documents receive a sandbox CSP with no scripts or same-origin permission, so delivered authoring HTML cannot approve its own package. No network listener beyond loopback or cross-origin mutation is offered.


## Feedback export

The frontend downloads `rig-review-feedback/1` JSON with `id`, `revision`, `sourceHash`, review status, `feedback[]`, and issue-ready `issues[]` entries containing title/body/labels. It also offers Markdown. Each issue contains the frame interval, target, category, summary and package binding. Exports stay local; no issue is posted automatically. These are review annotations, not motion or correction-key artifacts.


## Exact reviewed-source identity and retrieval

`reviewedSource` is server-produced and must return unchanged in submission, draft saves and exports. It contains `packageRevision` (the explicit manifest revision, or `folder-adapter/1`), `viewerVersion` (this app's package version), `runtimeVersion` (the installed `@rig-c/play` package version), and `rig`/`motion`, each null or `{path,sha256}` for the exact reviewed file bytes. No producer version is inferred from a report's generic version field.

The active compiled model supplies rig identity. Without one, a known root or uniquely declared authoring `skeleton.json`/`skeleton.skel` supplies raw evidence identity, still with playback unavailable. Motion identity comes from optional explicit `motion`, an actual root `motion.json`, or a uniquely declared authoring `motion.json`; no missing file receives a guessed hash. These known identity files join the source-hash/asset allowlist. Differently named motion sources require the explicit `motion` path. Each hash is streamed from exact bytes alongside the package hash. Submissions reject altered identity and revalidate current source before saving.

`bun run feedback -- <review.json|output-directory>` reads the existing bound session JSON after the UI closes. With no saved state it emits pending and `updatedAt: null`. It never writes source or creates a review submission. JSON/Markdown exports include this identity, so another agent can tell exactly which rig, motion and viewer revision a person reviewed.


## Historical feedback retrieval

`feedback` and `feedback compare` first return the exact current-tool stored session, including an explicitly saved pending decision. A corrupt current record is refused rather than replaced with an older approval. Current-file reads use an explicit present/missing result, and the CLI rechecks current state before returning history so a concurrently saved pending review wins without relying on its timestamp. If the current file is absent, these CLI commands search prior saved submissions for the same immutable content. HTTP session reads and all saves retain their existing strict current-tool binding; history is not approval migration.

For a single package, matching requires the same id, revision, source hash, package revision and exact rig/motion paths and hashes (including null artifacts). Only recorded viewer/runtime versions may differ. Compare lookup requires ordered A/B content bindings, the exact reference name/hash and animation. Its historical combined hash, compare id and state filename are verified against that record's own recorded tool versions, because those identifiers also change on tool upgrades.

The result retains the original status, feedback, recorded `reviewedSource`/comparison binding and `updatedAt`, with optional `retrieval:{kind:"prior-tools",toolsChangedSince:true,matchingSubmissions,currentTools}`. `currentTools` is `{viewerVersion,runtimeVersion}` for single mode or `{a:{viewerVersion,runtimeVersion},b:{viewerVersion,runtimeVersion}}` for comparison. Multiple matching prior records select the latest valid saved ISO timestamp; equal timestamps use lexical state filename order. Approval receives no priority over a later pending or changes-requested submission. A null or malformed submission timestamp is refused, never promoted to a submitted review.

Discovery reads only regular `<64 lowercase hex>.json` files in the private state directory and never follows candidate symlinks or opens paths embedded in JSON. Historical candidate reads are bounded to 32 MiB per file and 64 MiB per search, and more than 100 unreadable candidate files produce a named refusal. Unreadable/nonregular/unparseable unrelated files appear as `historyWarnings:[{file,error}]` rather than fabricated submissions. A matching record with contradictory binding, filename or other invalid session data fails by name. A missing directory or no matching submission yields fresh current pending; content changes never inherit historical approval. Neither lookup rewrites a state file, source asset, model or motion.

Existing legacy-feedback warnings remain visible when a historical row fails today's target/interval rules. The original evidence and recorded tool identity remain available, while resubmission to the current server still requires a valid current binding and corrected feedback.

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

Only selected-basis report `frameTimes` supplies strip times. A matching report animation is required. Uniform metadata remains supported by inspection transport but does not become a strip sampling substitute. A clockless JSON group keeps its inclusive frames and `time:null`; clockless PNG refuses with `report에 frameTimes 없음 — pose 0.30.0 이상으로 재생성`. A compare A without a clock remains renderable from B's explicit times and has no inferred A frame label. Each actual reference PTS is selected nearest to the request (ties earlier), and all rig rows use that same PTS. Requested/decoded times outside the common clip/video domain refuse, without a per-source clamp.

Each interval has its own source-row grid; overlapping groups preserve their feedback ids and repeated frames. Source packages and reference are checked before and after export, including exact model/page/motion bytes through existing package hashes. The PNG footer includes full rig/motion hashes (null stays absent), revisions, viewer/runtime and actual renderer versions. Exports are derived evidence, never a new source or approval. CLI destinations and `.json` sidecars must be new files outside both source roots; parent symlinks and existing targets are refused. Downloads have no arbitrary filesystem destination parameter.

The pure layout reserves a maximum `footerHeight` budget for complete provenance. The native renderer wraps the actual footer text before allocation and uses only that measured height; `rendering.width/height` records the actual PNG extent. Unsupported RGB/dark tint refuses by name (`STRIP_UNSUPPORTED_TINT`) rather than claiming Canvas2D pixel parity for features its published renderer omits.

A strip plan with one clock basis reports `plan.basis:"single"|"a"|"b"`. A comparison batch containing both sides reports `plan.basis:"mixed"`; each group still carries its own `basis` and its own report-derived sample times. Consumers must use the group basis for a mixed plan rather than treating the first group as a batch-wide clock. The selected basis row labels requested producer frames/times; actual PTS and independently calculated actual frames remain separate rendering metadata. Output containment and every parent-directory check use native platform separators, including Windows drive and UNC paths.

## Open-managed handoff and explicit single reference

`rig-review open <input> [--reference <local-video>] [--compare <input>]
[--animation <name>]` hashes and validates the input, starts/reuses a fixed-binding
background instance and prints a URL alone on stdout. Its matching read-only
`feedback <input> --reference <same-video> [--compare <input> --animation <name>]`
command is printed on stderr. Existing `feedback compare ...` remains supported.
An omitted comparison animation is accepted only for exactly one actual common
model animation; no filename or first-entry selection supplies a default.

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
