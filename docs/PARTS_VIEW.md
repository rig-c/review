# Parts and atlas view

Use **Setup** to inspect a parts package in the shared Review workspace. The
[screen specification](SCREENS.md) records the layout and controls.

`rig-review parts` shows a rig's parts as images, before any rig is built, so a part with missing material, a faint
island or a ragged rim is caught before rigging rather than in motion after it. Atlas-only inputs refuse
`PARTS_ATLAS_NOT_CARRIED` before the parts workspace opens. Use rig review for read-only atlas inspection;
`parts --format json|issue` still reads saved atlas verdicts.

```sh
npx rig-review parts <out>            # a rig-parts build root: opens <out>/rig/parts.json
npx rig-review parts <out>/rig        # the same package, named directly
npx rig-review open <out>/check       # inspect a built rig, including its read-only atlas
npx rig-review parts <out>/check --format json # read a saved atlas verdict without opening a workspace
```

Options: `--rig <file>` (mesh geometry), `--mesh-report <file>` and `--check <file>`
(producer reports), `--verdict <file>` (historical verdict location and local feedback directory),
`--painting <png>` (original painting), `--by <name>` (launch-only reviewer declaration),
`--format json|issue` (saved feedback export)
and `--port <n>`. The foreground server uses a 3-second grace period after the last live review connection closes.

## Inputs

| Mode | Input and availability | Items |
| --- | --- | --- |
| parts | a directory holding `parts.json` beside `parts/<name>.png`, as `rig-parts assemble` writes it, or a build root whose `rig/` holds them | every part, in `parts.json` order (draw order, back first) |
| atlas | a review package or build `check/` folder whose compiled model declares `pages[].regions[]`; read-only within rig review or saved-verdict export, refused at parts workspace open | every region, by page |

## What it shows

The left parts list controls selection and visibility. Use the shared viewport for
inspection and the secondary toolbar for Images, Mesh edges and painting Overlay.

## The sign-off

Use **Send comments** to save general or pointed comments from a standalone
parts view. Agents read the saves through `rig-review parts <dir> --format json|issue`.
See [Local comment sends](REVIEW_PACKAGE.md#local-comment-sends) for the schema.
Historical parts and atlas verdicts remain available in the same export.
A live job sends a finalized comment act through the
[standing live job workflow](WORKFLOWS.md#standing-live-job-workflow).
Reviewer wording stays verbatim.

## Pointed parts comments

Use **Comment · C** to open the right-hand Comments panel and enter pin mode.
Click or drag in the main view to mark the comment. Click a pin or comment row
to open it. Enter adds the comment, and Escape cancels the composer.
Use **Send comments** in the act bar to save the comments.
For an editable saved comment opened in the composer, eight handles resize its area and dragging its
interior moves it; Enter saves text and geometry, Escape reverts the edit, and Shift+drag starts a
new area over the selected area or its handles. Tags are recomputed after resize or move only until
a chip is touched in this edit; reopening a saved comment keeps its chosen tags.

Opening a source-bound issue row or pin keeps the current view and camera when its source and view
mode match the screen and, in item view, it names the same part. Otherwise, a valid issue restores
its saved item or assembled mode, mesh, painting comparison and any recorded layer visibility,
then writes the saved rig camera (adjusted for the part placement in item view with painting).
The reference camera aligns only when camera sync is currently on; stale source or part bindings
are refused. Atlas inspection remains read only for pointed comments. A standalone compiled session (`open --project --project-version N`) saves comments locally.
Feedback that must reach the producer goes through a
[live job](REVIEW_PACKAGE.md#live-job-contract). A joined draft open refuses that save with `MODEL_UNAVAILABLE`.
The former joined draft verdict writer refused pointed issues with
`PARTS_JOINED_ISSUE_UNSUPPORTED`. Review #1318 retired that writer.

`rig-review-parts-verdict/4` stores `issues[]` of closed `rig-review-parts-comment/2` records (historical `rig-review-parts-verdict/2` and `/3` stored `comments[]` of `rig-review-parts-comment/1`; a historical `/1` verdict file reads with an empty array).
Each historical closed `rig-review-parts-comment/1` carries `id`, original reviewer `summary`, `part`,
`imageHash` (SHA-256 of the original part PNG), `sourceHash` (the verdict source identity, or the server-retained publication `sourceHash` when prepared in a live job),
`imageRegion`, `rigRegion`, `view`, `crop` and `nativeCrop`; `rig-review-parts-comment/2` generalizes `part` + `imageHash` to a non-empty unique `parts: [{name, imageHash}]` array and supports `view.mode: "item"` (requiring integer `imageRegion`, exact `rigRegion = placement(parts[0]) + imageRegion`, and server-cut `nativeCrop`) and `view.mode: "assembled"` (`imageRegion: null`, `nativeCrop: null`, and integer `rigRegion` fully contained within the union bounding box of `parts`). `imageRegion` has integer native
pixel edges snapped outward from the drag. In item mode, `rigRegion` is exact placement plus that region,
including fractional placement; it is never rounded. `view.camera` records native scale,
centre and viewport extent, plus `cameraSync`, `referenceCamera`, `background`, `alpha`,
`footprints` and `mesh`. Current parts capture records a null reference camera,
checker background, and alpha and footprints off. Optional `view.comparison`
stores mode and opacity, plus an integer threshold in Difference mode. Older
comments can omit comparison and restore the ordinary part view. Invalid
comparison settings refuse `PARTS_COMPARISON_INVALID`.

The viewport `crop` comes from the shared displayed-pixel compositor and includes its mark.
In item mode, `nativeCrop` is cut on the server from the hash-bound original PNG, preserving all
RGBA bytes, including alpha. It has no alpha-mask, background or zoom transform. Assembled issues
retain their rig-space region and viewport crop, with `imageRegion` and `nativeCrop` both null.
Crops use the common PNG validator/content-addressed store and server-selected paths. The saved
viewport crop includes its private inline PNG. Exported JSON and issue Markdown resolve stored
crops to file paths and hashes and retain the referenced parts and regions.

### Assembled package

The parts view starts with **Whole rig** selected. Use the left parts list to select a part,
**Solo** to inspect it alone, and **Whole rig** to clear the selection. With a
declared `rig_size`, the assembly uses that canvas. Parts draw in package order
at their declared placements. A part's visibility checkbox controls whether it
draws in the assembly. Shared **Fit** and **1:1** controls remain available.

An assembled comment can span several parts. The composer suggests chips by
sampling the frontmost visible nontransparent parts in the marked region. If
sampling finds none, it falls back to overlapping visible parts, preferring
the selected part. Review the chips and add or remove visible parts as needed.
At least one referenced part is required, and the rig-space region must
remain inside their combined bounding box. Editing chips or wording validates and prepares the
candidate through the same source-bound crop pipeline before replacing the existing issue. A rejected
edit preserves the existing issue. Opening an assembled issue keeps an already matching assembled
view and shows its referenced parts as selected chips; a valid issue from a different context
restores its saved assembled view as described above. New assembled comments
record visible layers with their image hashes.

With `--painting`, the reference pane and Overlay use the whole-canvas visual
mapping described below. Atlas-only inputs cannot open the parts workspace.
Difference uses the individual part view described below.

### Visual painting comparison

```sh
npx rig-review parts <out>/rig --painting painting.png
npx rig-review parts <out>/rig --painting painting.png --format json
npx rig-review parts <out>/rig --painting painting.png --format issue
```

The optional painting must be a PNG contained in the parts package (including symlink resolution),
with a portable source path. In the live job host, a painting loaded from a retained snapshot via `paintingRoot` must instead resolve inside that snapshot root and match its retained seal. Format, size and hash derive from one buffer read. Its original dimensions
must satisfy `trunc(width × scale_rig_per_source) = rig_size[0]` and the equivalent height check
(`PARTS_PAINTING_SIZE`); missing/invalid declared geometry refuses `PARTS_PAINTING_MAPPING`.
The painting stays in `source.files` and the protected input set. Adding it to an older verdict changes
source identity and shows the existing stale-files warning; it never reuses that earlier approval.
`tests/parts-comparison.test.ts` and `tests/parts-comments.test.ts` guard these contracts and refusals.

Choose **Side by side** to inspect the parts and original painting together. The
Reference pane follows the selected part. **Overlay** draws the visible assembly
or Solo part over the painting. **Part opacity** ranges from 0 (painting) to 1
(parts composited over the painting).
Both use the existing canvas host/camera/capture. The original source rectangle is exactly
`(x × originalWidth/rigWidth, y × originalHeight/rigHeight, w × originalWidth/rigWidth,
h × originalHeight/rigHeight)`, retaining fractional placement. Browser image interpolation displays
this continuous rectangle; it does not reproduce the producer's resampling or claim native pixel equality.
Overlay retains Mesh edges. Without a painting, Overlay and Part opacity stay
disabled and name `PARTS_REFERENCE_UNAVAILABLE`. The native crop keeps the
original part RGBA, while the viewport crop shows the displayed comparison.
A current render failure can clear both canvases and block comment capture.
A failed Difference redraw can instead restore the last drawn state.
Superseded draws cannot publish a new frame.

The transform follows the whole-canvas geometry in pinned
[parts 2.17.0 sourceInRig](https://github.com/rig-c/parts/blob/971b3a7fab1109adf5be11750886687a7addb306/src/assemble.ts#L2141)
and the [parts coordinate contract](https://github.com/rig-c/parts/blob/971b3a7fab1109adf5be11750886687a7addb306/src/parts.ts#L14).
`tests/parts-comparison.test.ts` pins scale 0.5, fractional coordinates and truncated canvas dimensions.
`tests/viewport-controller.test.ts` guards a delayed reference-size change realigning the pair before gestures.
The public synthetic overlapping fixture is generated by `tests/helpers/parts-comparison-package.ts`.
The earlier visual-comparison release deferred Difference to
[consumer #390](https://github.com/rig-c/review/issues/390). The current producer-declared operand and
metric are documented under [Declared-grid Difference](#declared-grid-difference).

Parts native zoom ranges from the smaller of Fit and 1 up to 16. When cameras
are synced, the lower bound also accounts for the linked pane's Fit scale.
**Fit** and **1:1** are separate actions. Out-of-range native zoom requests
refuse as `PARTS_CAMERA_RANGE`. Compiled-rig zoom is Fit-relative (0.25–8).

Named comment refusals include `PARTS_COMMENT_EMPTY`, `PARTS_COMMENT_FRACTIONAL`,
`PARTS_COMMENT_OUT_OF_BOUNDS`, `PARTS_COMMENT_STALE_SOURCE`, `PARTS_COMMENT_RIG_REGION`,
`COMMENT_CROP_INVALID` and `PARTS_COMMENT_NATIVE_CROP_TAMPERED`. Request bodies retain the
4 MiB limit and same-origin capability gate. Native crops are limited to 16 million pixels;
viewport crops retain the rig comment's 200,000-character PNG limit.

Contract guards: `tests/parts-comments.test.ts`, `tests/viewport-controller.test.ts`,
`tests/comment-safety.test.ts`, `tests/stage-comments.test.ts` and `tests/i18n.test.ts`.
`tests/parts-comments-browser.ts` is separate real-browser evidence for cursor/pan/pinch,
two comments, save/reload, view restoration, both exports, EN/KO, native RGBA parity, painting
subrectangle parity, immutable source files and the compiled Stage 1 canonical host.

### Declared-grid Difference

Painting Difference reads `painting_in_rig: {path, sha256, resample:"lanczos3-rgb-opaque"}`
from `parts.json`. When the field is absent, Review looks for
`painting_in_rig.json` with schema `rig-parts-painting-reference/1`, the same
three operand fields, `manifest_sha256` matching the exact manifest bytes, and
`rig_size` matching the manifest.
The literal portable path resolves inside the package. Its PNG must be RGBA8,
alpha 255 and exactly `rig_size`; its bytes must match the declared SHA-256.
The artifact and any loaded sidecar join `source.files` and protected inputs. Original `--painting`
A/B and Overlay remain independent. Legacy inputs without either declaration
can still open. Painting Difference requests without a declared operand refuse
`PARTS_DIFFERENCE_UNAVAILABLE`.

The consumer is pinned to the published contract in
[@rig-c/parts 2.19.0](https://github.com/rig-c/parts/tree/193380b36b61a44daa3a4fcc5824a58efd6750a4).
This is assemble's operand: source RGB forced opaque, then producer Lanczos3.
Check instead flattens source alpha over its backdrop before resizing. The
[producer's per-example report](https://github.com/rig-c/parts/pull/1101)
reports equality for its five opaque example sources. That report is provenance,
not a consumer verdict or proof of `SETUP_MATCHES_PAINTING`.

For each original part cell with alpha > 0, the server compares stored RGB to
`painting_in_rig[x+cellX,y+cellY]`. No premultiplication, resampling or browser
pixel readback enters the metric. Difference is
`max(abs(dR),abs(dG),abs(dB))`, counted only when **strictly greater** than the
integer threshold (0–255). The parts workspace sends threshold 0. Above-threshold
cells are red with intensity equal to the difference. Other compared cells are
black, and alpha-zero cells are transparent. Difference does not approve a verdict.

The endpoint supports excluding covered cells with `footprints=true`. A cell
covered by a later overlapping part with alpha greater than zero is grey
(128,128,128) and excluded from the count. The shared parts workspace sends
`footprints=false`, which skips decoding and sampling front rasters. The
server decodes the part PNGs to RGBA and requires integer placement and PNG
dimensions matching the declared width and height. A nontransparent selected
cell outside the rig grid or fractional placement refuses
`PARTS_DIFFERENCE_ALIGNMENT`.

Difference comments retain `view.comparison:{mode:"difference",opacity,threshold}`
and the existing footprints, background and cameras. Older part/overlay states
keep their two-field shape. The common viewport crop captures the displayed
comparison; the native crop keeps original RGBA. Save, reopen, restore, JSON
and issue Markdown retain this state, with source checks before use.

Named input refusals: `PARTS_DIFFERENCE_PROVENANCE`, `PARTS_DIFFERENCE_PATH`,
`PARTS_DIFFERENCE_HASH`, `PARTS_DIFFERENCE_PNG`, `PARTS_DIFFERENCE_SIZE`,
`PARTS_DIFFERENCE_ALPHA`. A changed loaded input uses
`PARTS_VIEW_SOURCE_CHANGED`. No producer command executes for Difference.
`tests/parts-difference.test.ts` supplies literal independent numeric controls.

## Draft mesh correction connection

In a single compiled inspection with a live producer handoff, Stage 1 reads the
same original `parts.json`/PNGs through the existing reader and uses the exact
inspected or checked applied scratch `rig.json` for its mesh overlay. The
skin/slot/attachment, float32 UVs, dimensions and triangle arrays must match the
compiled model; raster equality is still proved by `locateMeshRasters`. Neither
matching names nor a shared folder is enough. Mismatch refuses by name.

The selected part opens the actual Chest regions, Mesh parameters or Edit Mesh
instrument, naming `remesh --mesh` or `remesh --delta`. The existing installed
producer writes only scratch. After Apply, inspect the applied revision in Setup.
Reset restores the inspected build. New applied chest and
delta records carry the producer check, counts, file diff and a scratch input
pin. Changed scratch input, pending builds and missing/failed checks cannot be
submitted as new checked made evidence. Historical records with no check remain
readable as historical evidence; no PASS is synthesized for them.

Stage 1 does not rewrite `rig-review-parts-verdict/2`: `source.files`,
`source.flags`, their digest, per-part outcomes and comment/crop/comparison
bindings remain the standalone original-parts contract. Scratch inspection
returns no inherited verdict. Its own parts digest and build evidence accompany
the original package `sourceHash`; original Review sessions/drafts remain scoped
to their original `sourceHash`/`reviewedSource`. A standalone parts-only package
names the absent draft instead of offering an Apply that cannot run.

The standalone [Correction handoff](WORKFLOWS.md#correction-handoff) workflow
exports supported saved corrections for Create. Existing
comments and feedback preserve reviewer wording, but are not a substitute for
that shared export or for create-owned structure decisions.

When `--project` and `--project-draft` select a recorded Create draft that declares its `config`, `parts`, `rig` and `check` directories, Stage 1 also enables the mesh correction instruments before a rig version exists while the draft is editable (`parts` or `parts-review` stage without an effective `parts-review` sign-off, and not `--view-only`). The status bar reports the recorded draft producer version as provenance alongside the installed producer and compiler versions; Apply runs the installed producer and compiler resolved by `resolveProducer` and its operation-capability floors (`REMESH_SINCE` and `REMESH_DELTA_SINCE`, plus `EDIT_PRODUCER_MISMATCH` if a patch's `producer` differs from the installed producer), without an equality version gate against the recorded draft producer. Opening an instrument switches to the Setup inspector for that mesh correction. Animate remains disabled with `RIG_VERSION_UNAVAILABLE` until a recorded rig review package is available. When the project stage is outside `parts`/`parts-review`, an effective `parts-review` sign-off is already recorded, or `--view-only` is set, Stage 1 remains inspection-only (`draft.inspectionOnly: true`) and hides the correction instruments.

On the `inspected` build, `--parts-verdict-dir` locates a source-bound historical
verdict for reading. Before #1318, the Stage 1 verdict writer required that
directory and refused scratch builds with `PARTS_VERDICT_READ_ONLY`.

### Reviewer name and saved-result read

Pass `--by` at launch to record the declared reviewer name.

```sh
npx rig-review parts /absolute/path/to/out/rig --by "Reviewer name"
npx rig-review parts /absolute/path/to/out/rig --format json
```

`--by` requires a nonblank name and stores the argument verbatim, including Unicode and surrounding
whitespace, on each local **Send comments** record. Empty, whitespace-only, duplicate or export/correction-mode use fails
with exit 1. The name comes from the launch declaration. Browser fields and a reader's identity provide
no attribution authority. Opening and reading preserve the saved bytes.

### Durable save notifications

Review #1233 retired standalone `POST /api/parts/verdict` and its
`RIG_REVIEW_PARTS_SAVED` stdout records. The former notification carried
`verdictPath`, the saved file's `sha256`, `status` and a process-scoped
`saveCount` after a durable verdict write.

Use **Send comments** to save local feedback. The page receives a receipt with
`sendId` and `at`. Read the stored comments with
`rig-review parts <dir> --format json|issue`. When an export includes a
historical verdict, `savedFileSha256` still identifies the verdict's raw
saved bytes. See [Local comment sends](REVIEW_PACKAGE.md#local-comment-sends).

## Compatibility and historical UI

### Historical comparison evidence

For real scaled evidence, `scripts/prepare-parts-overlay-demo.ts` fetches hash-verified public demo
inputs at `ba99e403d4058fc1cfe40699bdcde8aaf00a90c0`, then runs explicitly installed `@rig-c/parts@2.17.0`
assemble in a separate fixture directory. It is an evidence script, never an app action.

### Former standalone view

**Historical UI:** the following describes the former standalone parts page.
Use the current shared Setup workspace; these controls are not a second screen.

- **Every part on its own**, on a checker background by default (green, magenta, black and white are also available), at native scale with
  Fit and exact **1:1**, cursor-anchored wheel zoom, pinch and drag pan in the shared rig/reference viewport pair. Sampling stays nearest-neighbour. **Alpha only** shows the alpha channel as grey (white is opaque).
- **Footprints of parts in front** (parts mode): the alpha of every part later in `parts.json` whose box meets the
  selected part's box, placed by its rig box and tinted cyan at 50 %. Where the selected part has no pixel under its
  occluder, the tint lands on the bare sentinel, so a back part that stops exactly at its occluder's edge shows the
  occluder's shape at a glance. Nothing is measured; the tint is the front parts' own alpha.
- **Atlas mode**: the pages as packed, with each region's box and name; the background shows through padding, and a
  region's own view keeps 4 page pixels around its box (dashed) so bleed is visible. Clicking a region opens it.
- **Historical UI — Producer flags (removed in #745)**, read from the files rig-parts writes and shown on the part they name. None is re-measured here. Each reads as one labelled line (an opening's parts, animation, frame and cells; a seam pair's pixel counts; a gate's name, status and readings), with the producer's object verbatim under a collapsed **Producer line**.

The [23-part EN/KO comparison](https://github.com/rig-c/review/tree/main/tests/fixtures/parts-approve-all-evidence) records the same 1600×1100 initial view against installed 1.8.0: row height 49.375 → 26.1875 px, with all 23 after rows on one line (measured by `tests/parts-approve-all-browser.ts`, removed in #758).

### Producer row groups

**Historical UI:** sidebar groups and badges below were removed in #745.
The producer row metadata and legacy API/verdict references are preserved.

The sidebar counts **only mesh-report flags and explicit part findings**. A check row counts only
when `row_scope: "part"`, `row_kind: "finding"` and a valid `row_subjects` array names that part.
A block status, a JSON path, a reason or a legacy part/slot/bone field never determines classification.
Counts stay separate by source, for example **mesh 1 · check 1**; an absent report is not shown as zero.
A part with no counted flags has no count badge, even when it has other readings.

Rows appear beneath **mesh_report.json** / **check.json**, with collapsed categories and producer-root groups:
- **Part findings**: the explicitly attributed findings counted in the badge.
- **Pair readings**: pair findings on both explicit subjects, never counted.
- **Check evidence**: every evidence row and every rig row (including rig findings), never counted.
  Subject-bound evidence appears on its subjects; rig rows have no implied part and are visible on every selection.
- **Unclassified check rows**: incomplete or invalid metadata, never counted. In a mixed document an object row
  without a complete tuple remains visible here globally, without guessed subject attribution. The tuple requires
  scope part/pair/rig, kind finding/evidence, and respectively 1/2/0 distinct nonempty string subjects.
  If any subject is not held in this view, the entire tuple is unclassified globally, including a pair with one held subject. No partial or substitute attribution is made.

The reader walks all roots regardless of block status, nested observation arrays, alternate sets and
`requirements.lines` dictionaries. Singleton summaries are not rows, except that a top-level FAIL/WARN gate
without a tuple is preserved globally as unclassified, even in a labelled document. Its status does not make
it a classified finding. Each headline preserves root, exact path,
producer string fields and measurements. **Block** labels the enclosing block status; it never overrides the
row's kind. **Producer line** holds the full original row object. Producer values are never translated.

A document with no row metadata keeps #380's source-root extraction and attribution, explicitly **unclassified**.
It can retain unavailable support and informational pairs; none becomes a counted finding. The public legacy
[`parts-check-380.json`](https://github.com/rig-c/review/blob/main/tests/fixtures/parts-check-380.json) remains a
synthetic compatibility fixture. Its 11 historical check attributions remain in the verdict wire collection,
while its sidebar check finding count is absent (only the back defect's mesh flag counts).

The fixture contract is pinned to published **@rig-c/parts@2.17.0**, source
[`971b3a7`](https://github.com/rig-c/parts/tree/971b3a7fab1109adf5be11750886687a7addb306),
whose [consumer row table](https://github.com/rig-c/parts/blob/971b3a7fab1109adf5be11750886687a7addb306/docs/AUTHORING.md#consumer-check-rows-issue-1089)
and `src/checkrow.ts` define the fields. This is an evidence pin, not a runtime dependency or automatic install.
`tests/fixtures/parts-check-385-real.json` is the byte-exact public synthetic-rig check output from the installed
producer; check exit **1** is its deliberately planted stretch finding, not a green rig. The measurement packet's
exit 0 means capture completed. The separate `parts-check-385.json` is a clearly synthetic six-combination matrix,
including status/subject decoys. `parts-check-385.provenance.json` records hashes, source and the reproduction recipe.
`tests/parts-classification.test.ts` guards the actual DOM callers, API, classification and unchanged wire binding;
`tests/parts-classification-browser.ts` supplies real bilingual screenshots and collapsed/expanded/legacy checks.
Representative public screenshots: [English collapsed](https://github.com/rig-c/review/blob/main/tests/fixtures/parts-check-385-evidence/collapsed-en.png),
[English expanded](https://github.com/rig-c/review/blob/main/tests/fixtures/parts-check-385-evidence/expanded-en.png),
[Korean collapsed](https://github.com/rig-c/review/blob/main/tests/fixtures/parts-check-385-evidence/collapsed-ko.png),
[Korean expanded](https://github.com/rig-c/review/blob/main/tests/fixtures/parts-check-385-evidence/expanded-ko.png).

Classification is a separate read-only `readings` collection in the view response. The historical `flags`
collection and `buildVerdict` extraction remain unchanged: verdict/2 `parts.<name>.flags`, source file hashes,
comment serialization and create consumption keep their existing semantics. Display counts are not verdict IDs
or an approval decision. Changing the check document still invalidates an offered saved sign-off.

| Stored flag ID | Read from | Existing verdict/2 extraction (unchanged) |
| --- | --- | --- |
| `faint:<i>` | `mesh_report.json` beside `parts.json` | a faint island the mesh left out |
| `check:<path>` | `check/check.json` beside `rig/` | historical FAIL/WARN gates or seam/opening lists naming a part by a non-bone string field; this is not the new sidebar classification |

The occlusion-coverage report (rig-c/parts#998) is not read yet; the footprint toggle stands without it.

### Historical verdicts

Historically, **Approve all** marked every pending part and available mesh clean and saved an approved
sign-off. It preserved notes and existing clean outcomes, and refused flagged items.
Per-part approval and mesh outcomes belong to that historical UI and `/1`–`/3` read compatibility.
`tests/parts-view.test.ts` exercises verdict validation and historical
readers. Verdict validation refuses approvals with issues as
`PARTS_VERDICT_NOT_CLEAN`.

In historical `/1`–`/3` saves, each item was pending, clean or flagged with a note
(optional on clean). An unnamed historical `/2` save had this shape.

```json
{
  "schema": "rig-review-parts-verdict/2",
  "mode": "parts",
  "tool": { "name": "@rig-c/review", "version": "1.4.3" },
  "source": {
    "sha256": "…",
    "files": [{ "path": "parts.json", "bytes": 1234, "sha256": "…" }, { "path": "parts/hair_back.png", "bytes": 5678, "sha256": "…" }],
    "flags": [{ "path": "mesh_report.json", "sha256": "…" }]
  },
  "status": "pending",
  "parts": { "hair_back": { "outcome": "flagged", "note": "no material under the arm", "flags": ["faint:0"] } },
  "comments": [],
  "updatedAt": "2026-11-04T00:00:00.000Z"
}
```

- `mode` is `parts` or `atlas`. rig-c/create gates its `parts-review` stage on `parts` only.
- `source.files` binds the manifest and part PNGs plus applicable painting and mesh inputs (legacy atlas: the model and pages). Paths use POSIX separators relative to the verdict directory.
- `source.sha256` is the SHA-256 of the UTF-8 lines `<path>\t<sha256>\n`, one per `source.files` entry, sorted by path
  bytewise. Review revalidates inspected inputs when reading a saved verdict.
- `source.flags` lists the producer files the flags were read from; `parts.<name>.flags` the historical producer-attribution IDs defined above, not the classified sidebar count.
- Historical `/2` `status` is `approved` when every part is clean, `changes-requested` with at least one
  flagged part, and otherwise `pending`.

Historical per-part validation refusals include `PARTS_VERDICT_MISSING_PART`, `PARTS_VERDICT_UNKNOWN_PART`, `PARTS_VERDICT_NOTE_REQUIRED`,
`PARTS_VERDICT_NOT_CLEAN` and `PARTS_VERDICT_NOTHING_FLAGGED`. Verdict validation uses `PARTS_VERDICT_INVALID`
for invalid verdicts. A changed inspected file can trigger `PARTS_VIEW_SOURCE_CHANGED` on source revalidation.

A verdict path that matches a protected part, producer report, rig/package input, model or atlas image
still refuses with `PARTS_VERDICT_INPUT_COLLISION`, including normalized paths, symbolic links and filesystem
aliases. Use a separate historical verdict file.

Standalone local comment requests are limited to 4 MiB (4,194,304 bytes) of
UTF-8 while streaming. An over-limit body is cancelled before its remainder
is read, and a valid request exactly at the byte limit is accepted. The request
must be same-origin and carry the write capability when the server requires it.

**Historical flag-bound sign-off UI:** on reopen, the former page offered a saved sign-off only when both `source.sha256` and `source.flags` matched the files on disk.
**Historical UI:** when only the producer flags differed, the page said the saved sign-off was for different producer flags and started fresh.
Consumers that gate on the sign-off (rig-c/create) check `source.sha256`.

Every file the view reads from a package resolves inside it: a part PNG or `parts.json` that symlinks out is refused
as `PARTS_IMAGE_OUTSIDE` / `PARTS_FILE_OUTSIDE`, and a discovered `mesh_report.json` or `check.json` as
`PARTS_FLAGS_OUTSIDE`. Atlas pages go through the review package's own `safeFile`. A file named on the command line
(`--mesh-report`, `--check`) is read where it is.

Editing parts is out of scope: repairs go through the producer's source ladder, never the browser.

### Historical attribution and export compatibility

| Saved revision | Attribution on default CLI JSON read |
| --- | --- |
| Legacy `rig-review-parts-verdict/1` or `/2` | `by: null`, including an ignored historical `by` extension |
| Named `rig-review-parts-verdict/3` | Required nonblank `by`, preserved verbatim |
| Pointed-issue `rig-review-parts-verdict/4` | `issues: PartsIssue[]` (`rig-review-parts-comment/2`), optional nonblank `by` (`null` on CLI read when omitted) |
| Historical explicit resave from an unnamed launch | New `/4` save (historical `/2` before `/4`) with `by: null` on read, clearing the earlier name |

Named `/3` keeps the existing historical verdict fields and adds required `by`. Pointed-issue `/4` replaces the per-part outcome map with `issues` (`rig-review-parts-comment/2`) and optional `by`; historical `/1`, `/2` and `/3` saves that are `pending` or contain bare flagged part or mesh notes without a matching comment surface in the UI as read-only legacy verdicts (`PARTS_VERDICT_LEGACY_FORMAT`, `flaggedCount`) and preserve their historical `/1`..`/3` schema and `parts` map on `parts <input> --format json`. A missing, null, non-string or
whitespace-only `/3` (or present `/4`) name refuses `PARTS_VERDICT_INVALID`. Older executables accepting only `/1` and `/2`
reject named `/3` with that refusal. This opt-in saved-format compatibility cost is part of the contract.

Ordinary `parts <input> --format json` returns `schema: "rig-review-parts-verdict/4"` (`mode`, `tool`, `source`, `status`, `issues` with resolved `crop.path` and `nativeCrop.path`, and `updatedAt`) for `/4` saves and for historical `/1`..`/3` saves whose flags are all covered by pointed comments (or that are approved with no issues, where `/1` normalizes to `issues: []`), while historical `/1`..`/3` saves that are `pending` or carry bare flagged part or mesh notes retain their historical `schema` (`"rig-review-parts-verdict/1"`, `"/2"`, or `"/3"`), per-part outcomes, notes and flags, available mesh outcomes and notes, optional `comments`, `issues` and `updatedAt`. Every CLI JSON read adds root `by: string | null` and
`savedFileSha256`, a 64-character lowercase hexadecimal SHA-256 of the exact saved bytes, including any
final LF, retaining the original byte digest on legacy reads.

The core, recorded name and digest derive from one validated saved-file snapshot, with current source
and producer-flag checks. `source.sha256`, `source.files` and `source.flags` retain the inspected-input
binding. Exported comment crops retain resolved paths and hashes. Missing or stale saves refuse
`PARTS_VERDICT_UNAVAILABLE` with exit 1 and no successful JSON result. Read, date, JSON and evidence
failures retain their named refusals.

Agents retrieve the result through this CLI using the same input options and designated `--verdict`
when supplied. Storage layout stays internal. `savedFileSha256` identifies raw saved bytes. Create's
separate receipt hashes the exact CLI stdout, whose normalized JSON and metadata have their own byte
identity. The recorded reviewer name is bootstrap-declared provenance. Issue and correction exports
retain their existing forms.

## Mesh geometry

**Historical UI:** the toggle labels and geometry/numbers panel below describe
the removed standalone parts page (#745). Current visual inspection uses Mesh
edges in the shared workspace. Geometry inputs and legacy wire references below
remain compatibility information, not a request to restore the old panel.

In parts mode, a `rig.json` beside `parts.json` supplies optional mesh geometry;
`--rig <file>` selects an explicit input instead. The workspace-wide **mesh from
rig.json UVs** toggle starts off and retains its setting across part selection, assembled view,
Overlay and Difference in both standalone and live job hosts. It draws edges and vertices for
visible mesh-bearing parts. The selected part also tints nontransparent art pixels pink when their
centres lie outside every nondegenerate triangle (triangle boundaries count as covered).
Other assembled meshes use reduced-opacity wire lines. The selected part's geometry panel names
unavailable geometry explicitly. A draft with no mesh geometry retains a **Mesh (none 0/n)** control
and an unavailable message. A mesh attachment that declares a plain-object `generator` without inline
`uvs` or `triangles` is accepted without reconstructing geometry. Its part raster renders normally
without a mesh overlay, the item reports `meshUnavailable: "PARTS_MESH_GENERATED"`, and the **Mesh
geometry** panel states `PARTS_MESH_GENERATED: No mesh geometry is available for this part.` Non-object
`generator` values or attachments combining `generator` with `uvs` or `triangles` still refuse by name.

Historical per-part mesh outcomes had Pending / Clean / Flagged states and a note. Flagged required a
note, and approval required clean part and mesh outcomes. These fields remain legacy read data.

Image-space positions are `(u × width, v × height)` from each attachment's own
UVs and dimensions, never reconstructed through bones or weights. The mesh's raster
is the rig image; the parts PNG is located inside it by pixel equality. The
attachment's literal `image` under the rig spec's literal `images` directory must
be a local PNG of exactly the declared dimensions. Its centred window must match
the parts PNG RGBA exactly, and every pixel outside must have alpha zero. The
window offset `((W-w)/2,(H-h)/2)` is subtracted from mesh positions. Fractional
or negative offsets refuse; no padding constant is assumed. Border vertices
are allowed and drawn clipped. The rig raster is hashed in `source.files`. The producer
rounds UVs to six decimals: the coordinate error is at most `0.5e-6 × dimension`
pixels on each axis (for a 598×465 image, at most 0.000299 and 0.0002325 px).
The overlay cannot show this subpixel error, and coverage tint works at whole
pixels, so it cannot move a tinted pixel unless a triangle edge lies within that
rounding distance of a pixel centre. Coverage describes these derived triangles,
not an exact recovery of the producer's original unrounded positions.

Mode, vertex count, triangle count, `art_coverage` and `stray_cleared` are copied
from the part's `mesh_report.json` row without recomputing them. Absent fields
say **not reported**; **historical UI:** faint islands remained in Producer flags. A report count may
differ from the loaded geometry. These are producer readings. Historical verdicts stored
`parts[name].mesh` as `{outcome,note}` only for a mesh-bearing part.
`rig.json` and the loaded mesh report enter `source.files`, and the mesh report
also remains in `source.flags`. Changes invalidate the saved sign-off. No rig
means the existing parts view and verdict format remain unchanged.

| Refusal | Found / required |
| --- | --- |
| `PARTS_MESH_UNKNOWN_PART` | An attachment name not in parts.json / a known part |
| `PARTS_MESH_UV` | Invalid coordinate pairs or UV outside [0,1] / finite UV pairs in [0,1] |
| `PARTS_MESH_TRIANGLE` | Invalid triples or index / integer indices within the vertex array |
| `PARTS_MESH_SIZE` | Invalid declared dimensions / positive integer dimensions and image |
| `PARTS_MESH_IMAGE_SIZE` | Raster size / attachment dimensions |
| `PARTS_MESH_IMAGE_MISMATCH` | First differing RGBA pixel, nontransparent border or incompatible crop / exact centred window and transparent border |
| `PARTS_MESH_IMAGE_PATH` | Unsafe or missing rig raster / literal inside path |
| `PARTS_MESH_IMAGE_FORMAT` | Undecodable raster / PNG |
| `PARTS_MESH_AMBIGUOUS` | Multiple mesh attachments for one name / one mesh |
| `PARTS_MESH_REPORT_AMBIGUOUS` | Multiple report rows for a mesh part / at most one |
| `PARTS_MESH_MALFORMED` | Missing skins object / a rig spec with skins |
| `PARTS_MESH_OUTSIDE` | A discovered rig symlink escaping the package / an inside file |
| `PARTS_MESH_OUTCOME` | Missing or invalid mesh outcome or oversized note / a valid outcome and bounded note |
| `PARTS_MESH_OUTCOME_UNAVAILABLE` | Mesh outcome on a part without a mesh / no mesh outcome |

Explicit CLI file paths are the user's designation, as with `--mesh-report`;
discovered paths cannot escape the package. This view never writes geometry,
bones, weights or source images. Repairs remain producer config changes.

**Historical UI:** The four-stage navigator exposed this entry and its explicit verdict save. Compiled sessions reuse the atlas surface read-only. See [Four inspection stages](PANELS.md#four-inspection-stages).

The superseded #387 byte-equality comparator scripts are retired; commit #388 retains their
original reproduction. Camera persistence wiring tests with live callers remain.

Native-crop revalidation checks the stored PNG file hash/dimensions and decoded RGBA against the
original subrectangle, rather than requiring a particular encoder's PNG bytes. Verdict reads never
create or rewrite crop files. Missing/unreadable stored evidence surfaces
`COMMENT_CROP_STATE_UNAVAILABLE`; invalid native pixels surface `PARTS_COMMENT_NATIVE_CROP_TAMPERED`.
These are validation failures. The former writer also refused to save while the existing verdict
could not be revalidated. Real source/flag identity changes retain their
separate stale warning. `PARTS_PAINTING_OUTSIDE` and `PARTS_PAINTING_PNG` refuse external or non-PNG
painting inputs. `tests/parts-comments.test.ts` covers these read and cross-encoding boundaries;
`tests/parts-async-navigation.test.ts` guards reordered painting loads and actionable atlas clicks.
The historical verdict/2 rollout required downstream create read support before release.

Saved standalone part notes and pointed comments can be selected as described
corrections. The handoff keeps the part and original image evidence. Its Create
selector is a retained parts inventory, with no rig version.
See [Correction handoff](WORKFLOWS.md#correction-handoff).
