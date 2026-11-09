# Parts and atlas view

`rig-review parts` shows a rig's parts as images, before any rig is built, so a part with missing material, a faint
island or a ragged rim is caught before rigging rather than in motion after it. The same view reads a built rig's atlas
to check what ships.

```sh
npx rig-review parts <out>            # a rig-parts build root: opens <out>/rig/parts.json
npx rig-review parts <out>/rig        # the same package, named directly
npx rig-review parts <out>/check      # a built rig's atlas (any review package with a compiled model)
```

Options: `--rig <file>` (mesh geometry), `--mesh-report <file>`, `--check <file>` (producer flags; see below), `--verdict <file>` (where the sign-off
is written), `--painting <png>` (the original painting), `--by <name>` (launch-only reviewer declaration), `--format json|issue` (export the saved verdict), `--port <n>`. Like `review`, it serves in the foreground and exits 3 s after its last tab closes.

## Inputs

| Mode | Opens on | Items |
| --- | --- | --- |
| parts | a directory holding `parts.json` beside `parts/<name>.png`, as `rig-parts assemble` writes it, or a build root whose `rig/` holds them | every part, in `parts.json` order (draw order, back first) |
| atlas | a review package or build `check/` folder whose compiled model declares `pages[].regions[]` | every region, by page |

## What it shows

- **Every part on its own**, on a sentinel background (green, magenta, black, white or checker), at native scale with
  Fit and exact **1:1**, cursor-anchored wheel zoom, pinch and drag pan in the shared rig/reference viewport pair. Sampling stays nearest-neighbour. **Alpha only** shows the alpha channel as grey (white is opaque).
- **Footprints of parts in front** (parts mode): the alpha of every part later in `parts.json` whose box meets the
  selected part's box, placed by its rig box and tinted cyan at 50 %. Where the selected part has no pixel under its
  occluder, the tint lands on the bare sentinel, so a back part that stops exactly at its occluder's edge shows the
  occluder's shape at a glance. Nothing is measured; the tint is the front parts' own alpha.
- **Atlas mode**: the pages as packed, with each region's box and name; the background shows through padding, and a
  region's own view keeps 4 page pixels around its box (dashed) so bleed is visible. Clicking a region opens it.
- **Producer flags**, read from the files rig-parts writes and shown on the part they name. None is re-measured here. Each reads as one labelled line (an opening's parts, animation, frame and cells; a seam pair's pixel counts; a gate's name, status and readings), with the producer's object verbatim under a collapsed **Producer line**.

The [23-part EN/KO comparison](https://github.com/rig-c/review/tree/main/tests/fixtures/parts-approve-all-evidence) records the same 1600×1100 initial view against installed 1.8.0: row height 49.375 → 26.1875 px, with all 23 after rows on one line (`tests/parts-approve-all-browser.ts`).

### Producer row groups

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

## The sign-off

Standalone sign-off uses saved files. The active Create and Parts cycle uses finalized acts through the
[standing live job workflow](WORKFLOWS.md#standing-live-job-workflow).

**Approve all** marks every pending part and available mesh clean, then saves an explicit approved sign-off. It preserves notes and existing clean outcomes; any flagged part or mesh refuses with `PARTS_APPROVE_ALL_FLAGGED` before changes are made. Individual approval remains available. `tests/parts-approve-all.test.ts` exercises the page action and unchanged verdict guard; `tests/parts-approve-all-browser.ts` checks the real save and refusal flows.

Each item is **pending**, **clean** or **flagged** with a note (a note is optional on clean). **Save sign-off**
writes `parts-review.json` beside `parts.json` (atlas mode: beside the model), or to `--verdict`.
An unnamed save has the following `/2` shape.

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
- `source.files` is `parts.json` and every part PNG (atlas mode: the model and every page), each path **relative to the
  verdict file's directory**, POSIX separators. A part added, removed or repainted after sign-off changes the hash.
- `source.sha256` is the SHA-256 of the UTF-8 lines `<path>\t<sha256>\n`, one per `source.files` entry, sorted by path
  bytewise. Review revalidates inspected inputs when reading a saved verdict.
- `source.flags` lists the producer files the flags were read from; `parts.<name>.flags` the historical producer-attribution IDs defined above, not the classified sidebar count.
- `status`: `approved` only when every part is clean; `changes-requested` only with at least one part flagged;
  otherwise `pending`.

Refusals, by name: `PARTS_VERDICT_MISSING_PART`, `PARTS_VERDICT_UNKNOWN_PART`, `PARTS_VERDICT_NOTE_REQUIRED`,
`PARTS_VERDICT_NOT_CLEAN`, `PARTS_VERDICT_NOTHING_FLAGGED`, `PARTS_VERDICT_INVALID`, and `PARTS_VIEW_SOURCE_CHANGED`
when a file changed after the view opened.

A verdict destination matching a protected part, producer report, rig/package input, model or atlas image is
refused as `PARTS_VERDICT_INPUT_COLLISION`, including normalized paths, symbolic links and filesystem aliases.
Choose a separate verdict file; saving an existing verdict again remains supported.

Sign-off JSON requests are limited to 4 MiB (4,194,304 bytes) of UTF-8 while streaming. An over-limit body is
cancelled before its remainder is read; a valid request exactly at the byte limit is accepted. Same-origin and
write-capability requirements remain unchanged.

On reopen, a saved sign-off is offered only when both `source.sha256` and `source.flags` match the files on disk. When
only the producer flags differ, the page says the saved sign-off is for different producer flags and starts fresh.
Consumers that gate on the sign-off (rig-c/create) check `source.sha256`.

Every file the view reads from a package resolves inside it: a part PNG or `parts.json` that symlinks out is refused
as `PARTS_IMAGE_OUTSIDE` / `PARTS_FILE_OUTSIDE`, and a discovered `mesh_report.json` or `check.json` as
`PARTS_FLAGS_OUTSIDE`. Atlas pages go through the review package's own `safeFile`. A file named on the command line
(`--mesh-report`, `--check`) is read where it is.

Editing parts is out of scope: repairs go through the producer's source ladder, never the browser.

### Reviewer name and saved-result read

HQ supplies `--by` when launching owner-facing standalone parts windows.

```sh
npx rig-review parts /absolute/path/to/out/rig --by "Reviewer name"
npx rig-review parts /absolute/path/to/out/rig --format json
```

`--by` requires a nonblank name and stores the argument verbatim, including Unicode and surrounding
whitespace, on each explicit Save. Empty, whitespace-only, duplicate or export/correction-mode use fails
with exit 1. The name comes from the launch declaration. Browser fields and a reader's identity provide
no attribution authority. Opening and reading preserve the saved bytes.

| Saved revision | Attribution on default CLI JSON read |
| --- | --- |
| Legacy `rig-review-parts-verdict/1` or `/2` | `by: null`, including an ignored historical `by` extension |
| Named `rig-review-parts-verdict/3` | Required nonblank `by`, preserved verbatim |
| Explicit resave from an unnamed launch | New ordinary `/2` save with `by: null` on read, clearing the earlier name |

Named `/3` keeps the existing verdict fields and adds required `by`. A missing, null, non-string or
whitespace-only `/3` name refuses `PARTS_VERDICT_INVALID`. Older executables accepting only `/1` and `/2`
reject named `/3` with that refusal. This opt-in saved-format compatibility cost is part of the contract.

Ordinary `parts <input> --format json` returns normalized `schema: "rig-review-parts-verdict/2"` with
every existing field, including `mode`, `tool`, `source`, `status`, all per-part outcomes, notes and flags,
available mesh outcomes and notes, `comments` and `updatedAt`. It adds root `by: string | null` and
`savedFileSha256`, a 64-character lowercase hexadecimal SHA-256 of the exact saved bytes, including any
final LF. Legacy reads retain their original byte digest and `/1` normalizes to empty comments.

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

### Durable save notifications

Each successful standalone Save emits one UTF-8 stdout record after file and parent-directory fsync.
The illustrative path and digest below show the framing.

```text
RIG_REVIEW_PARTS_SAVED {"verdictPath":"/absolute/path/to/parts-review.json","sha256":"0000000000000000000000000000000000000000000000000000000000000000","status":"approved","saveCount":1}
```

Match the literal `RIG_REVIEW_PARTS_SAVED ` prefix, including its ASCII space, then parse the compact
JSON with keys `verdictPath`, `sha256`, `status`, `saveCount` in that order and one terminating LF.
Control characters and U+2028/U+2029 are escaped within the JSON. Accept complete LF-terminated records.
Existing startup output shares stdout. The writer awaits output completion and backpressure before
reporting ordinary save success.

`sha256` hashes the exact committed save buffer (matching `savedFileSha256` when that commit is read via
`--format json`, and distinct from the normalized CLI stdout receipt bytes) and uses 64 lowercase hex
characters. `status` is
`pending`, `approved` or `changes-requested`. Saves are serialized within one foreground process.
`saveCount` starts at 1 and advances through 2, 3 and onward for every durable save, including identical
saves, then restarts with a new process. The positive safe-integer counter is process-scoped.
`verdictPath` is informational. Agents query the CLI above for the validated result. A later save can
give that read a different digest.

A failed durable write emits zero save events and leaves the counter unadvanced, with named
`PARTS_VERDICT_WRITE_FAILED` or the existing validation refusal. Pre-replacement failure preserves the
previous file. Post-replacement durability failure can leave visible bytes requiring CLI readback.
Stdout failure after commit, including EPIPE, reports `PARTS_VERDICT_NOTIFY_FAILED` and exit 1 while
preserving the committed file and allocated count. Recovery uses CLI readback. Automatic save or
notification replay is disabled. A crash between commit and delivery can lose the event. The guarantee
covers an emission attempt after each durable commit while the process and stream remain available.
Crash-proof exactly-once delivery requires an additional acknowledgment/replay protocol.

## Mesh geometry

In parts mode, a `rig.json` beside `parts.json` supplies optional mesh geometry;
`--rig <file>` selects an explicit input instead. The per-part **mesh from
rig.json UVs** toggle starts off. It draws edges and vertices over the sentinel
background, and tints nontransparent art pixels pink when their centres lie
outside every nondegenerate triangle (triangle boundaries count as covered).
The mesh outcome has its own Pending / Clean / Flagged states and note; Flagged
requires a note. Approval requires both part and mesh outcomes to be Clean.
A part without a mesh has no mesh controls or outcome.

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
say **not reported**; faint islands remain in Producer flags. A report count may
differ from the loaded geometry; it is the producer's reading. The verdict's
`parts[name].mesh` contains `{outcome,note}` only for a mesh-bearing part.
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

The four-stage navigator preserves this entry and its explicit save behavior. Compiled sessions reuse the atlas surface read-only; see [Four inspection stages](PANELS.md#four-inspection-stages).

## Pointed parts comments

**Comment · C (n)** uses the same capture toggle, dragged region, composer and pins as the rig stage.
While capture is on, drag draws only a region; close the toggle to pan. Enter adds the comment;
**Save sign-off** persists the verdict. Select a comment row or pin after reopening to restore its
part, both cameras, background, alpha, footprints, mesh and painting comparison view. There is no frame, animation or slot
placeholder in a parts comment. Atlas inspection remains read only for pointed comments.

`rig-review-parts-verdict/2` adds `comments[]`; a `/1` file reads with an empty comment array.
Each closed `rig-review-parts-comment/1` carries `id`, original reviewer `summary`, `part`,
`imageHash` (SHA-256 of the original part PNG), `sourceHash` (the verdict source identity),
`imageRegion`, `rigRegion`, `view`, `crop` and `nativeCrop`. `imageRegion` has integer native
pixel edges snapped outward from the drag. `rigRegion` is exact placement plus that region,
including fractional placement; it is never rounded. `view.camera` records native scale,
center and viewport extent, plus `cameraSync` and the actual `referenceCamera` (or null), alongside `background`, `alpha`, `footprints` and `mesh`. New comments add optional
`view.comparison: {mode:"part"|"overlay", opacity:0..1}`; older comments omit it and restore the
ordinary part view. Unknown modes/keys and out-of-range opacity refuse `PARTS_COMPARISON_INVALID`.

The viewport `crop` comes from the shared displayed-pixel compositor and includes its mark.
`nativeCrop` is cut on the server from the hash-bound original PNG, preserving all RGBA bytes,
including alpha. Both use the common PNG validator/content-addressed store; paths are selected
by the server. The native crop has no alpha-mask, background or zoom transform. The saved
viewport crop includes its private inline PNG; exported JSON and issue Markdown replace it
with a resolved file path and hash. Both exports name the part and both regions and crops.

```sh
npx rig-review parts <out>/rig --painting painting.png
npx rig-review parts <out>/rig --painting painting.png --format json
npx rig-review parts <out>/rig --painting painting.png --format issue
```

The optional painting must be a PNG contained in the parts package (including symlink resolution),
with a portable source path. Format, size and hash derive from one buffer read. Its original dimensions
must satisfy `trunc(width × scale_rig_per_source) = rig_size[0]` and the equivalent height check
(`PARTS_PAINTING_SIZE`); missing/invalid declared geometry refuses `PARTS_PAINTING_MAPPING`.
The painting stays in `source.files` and the protected input set. Adding it to an older verdict changes
source identity and shows the existing stale-files warning; it never reuses that earlier approval.
`tests/parts-comparison.test.ts` and `tests/parts-comments.test.ts` guard these contracts and refusals.

### Visual painting comparison

The existing reference viewport provides side-by-side A/B. **Overlay** draws the selected part over
that original painting at adjustable **Part opacity** (0 = painting, 1 = part composited over painting).
Both use the existing canvas host/camera/capture. The original source rectangle is exactly
`(x × originalWidth/rigWidth, y × originalHeight/rigHeight, w × originalWidth/rigWidth,
h × originalHeight/rigHeight)`, retaining fractional placement. Browser image interpolation displays
this continuous rectangle; it does not reproduce the producer's resampling or claim native pixel equality.
Alpha-only and mesh diagnostics are disabled in Overlay; front footprints remain available.
Without a painting the comparison controls are absent and the reference pane names
`PARTS_REFERENCE_UNAVAILABLE`. No comparison changes the verdict. These behaviors are guarded by
`tests/parts-comparison.test.ts`; `tests/parts-overlay-browser.ts` separately exercises trusted input,
actual displayed pixels, camera preservation, mode/opacity save/reload/restore and both exports in EN/KO.
Its native crop remains the original part RGBA, while the viewport crop shows the displayed comparison.
A current image/painting render failure clears the part pixels and refuses comment creation/editing
as `PARTS_PAINT_FAILED` until a successful repaint. Both buffers clear and both cameras reset to
1:1 centred on the actual canvas. Zoom, pan, Fit and saved comment/stage camera restoration stay
locked until rendering succeeds; retrying the part restores its painted frame before navigation resumes.
Older failed generations cannot invalidate a
newer successful view (`tests/parts-async-navigation.test.ts`; focused browser evidence in
`tests/parts-paint-failure-browser.ts`).

The transform follows the whole-canvas geometry in pinned
[parts 2.17.0 sourceInRig](https://github.com/rig-c/parts/blob/971b3a7fab1109adf5be11750886687a7addb306/src/assemble.ts#L2141)
and the [parts coordinate contract](https://github.com/rig-c/parts/blob/971b3a7fab1109adf5be11750886687a7addb306/src/parts.ts#L14).
`tests/parts-comparison.test.ts` pins scale 0.5, fractional coordinates and truncated canvas dimensions.
`tests/viewport-controller.test.ts` guards a delayed reference-size change realigning the pair before gestures.
The public synthetic overlapping fixture is generated by `tests/helpers/parts-comparison-package.ts`.
For real scaled evidence, `scripts/prepare-parts-overlay-demo.ts` fetches hash-verified public demo
inputs at `ba99e403d4058fc1cfe40699bdcde8aaf00a90c0`, then runs explicitly installed `@rig-c/parts@2.17.0`
assemble in a separate fixture directory. It is an evidence script, never an app action.

**Difference remains absent** pending the producer-declared rig-space painting raster and
[the waiting consumer #390](https://github.com/rig-c/review/issues/390). Review adds no producer resampler.
Neither visual comparison nor opening a package supplies an approval.

Parts native zoom ranges from `min(fit, 1)` to 16. Exact native 1 is always reachable for a valid,
successfully rendered frame. **Fit** is
a separate action, and **1:1** is shown only at exactly 1. Out-of-range requests refuse as
`PARTS_CAMERA_RANGE`; the compiled rig's Fit-relative 0.25–8 policy stays unchanged.

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
The superseded #387 byte-equality comparator scripts are retired; commit #388 retains their
original reproduction. Camera persistence wiring tests with live callers remain.

Native-crop revalidation checks the stored PNG file hash/dimensions and decoded RGBA against the
original subrectangle, rather than requiring a particular encoder's PNG bytes. Verdict reads never
create or rewrite crop files. Missing/unreadable stored evidence surfaces
`COMMENT_CROP_STATE_UNAVAILABLE`; invalid native pixels surface `PARTS_COMMENT_NATIVE_CROP_TAMPERED`.
These are validation failures, not a stale-source warning or a reset: a subsequent save also refuses
while the existing verdict cannot be revalidated. Real source/flag identity changes retain their
separate stale warning. `PARTS_PAINTING_OUTSIDE` and `PARTS_PAINTING_PNG` refuse external or non-PNG
painting inputs. `tests/parts-comments.test.ts` covers these read and cross-encoding boundaries;
`tests/parts-async-navigation.test.ts` guards reordered painting loads and actionable atlas clicks.
A downstream create consumer must support verdict/2 before a review release can ship.

### Assembled package

**Assembled** toggles the existing rig/reference pair from the selected part to the declared
`rig_size` canvas. Parts draw back to front in package order at their exact fractional rig-pixel
placements. The checkbox beside each part controls assembly visibility only; the verdict remains
per part. List rows occupy one line, with full part names available to assistive technology and on hover, separate source counts and the outcome badge. The former **Visible / 표시** caption is removed; the checkbox retains its per-part accessible name (`tests/parts-approve-all.test.ts`, with full-list geometry in `tests/parts-approve-all-browser.ts`). A tap selects the frontmost visible part with nonzero native source alpha, including
through transparent holes; drags remain camera gestures. The selected part's alpha edge is a
separate outline, outside the comparison raster. Background, alpha-only, Fit, 1:1 and the shared
camera controls remain available. `tests/parts-assembly.test.ts` guards fractional placement,
order controls, picking, hidden layers, separate outline pixels and per-part verdict invariance.

With `--painting`, the reference pane and optional Overlay use the same whole-canvas visual
mapping described above. No producer resampler, Difference or assembled verdict is added.
Without painting the reference keeps `PARTS_REFERENCE_UNAVAILABLE`; atlas assembly is disabled
because atlas regions carry no rig placement, and missing `rig_size` is named separately.
Comments remain bound to individual original PNGs: switch out of assembly to capture one;
restoring a saved comment returns to its individual part view. Assembly visibility is temporary
inspection state and is never saved into a verdict or comment. `tests/parts-assembly-browser.ts`
checks real EN/KO assembly/reference pixels against an independent browser draw after a
base-vs-base control, tap/hole/hide selection, pan, camera preservation, background, alpha,
verdict save and missing-input refusals. Existing `tests/parts-comparison.test.ts` and
`tests/parts-comments.test.ts` retain the painting-size and protected-input guards.

## Draft mesh correction connection

In a single compiled inspection with a live producer handoff, Stage 1 reads the
same original `parts.json`/PNGs through the existing reader and uses the exact
inspected or checked applied scratch `rig.json` for its mesh overlay. The
skin/slot/attachment, float32 UVs, dimensions and triangle arrays must match the
compiled model; raster equality is still proved by `locateMeshRasters`. Neither
matching names nor a shared folder is enough. Mismatch refuses by name.

The selected part opens the actual Chest regions, Mesh parameters or Edit Mesh
instrument, naming `remesh --mesh` or `remesh --delta`. The existing installed
producer writes only scratch. Return to Stage 1 after Apply to inspect the
recorded revision; Reset restores the original revision. New applied chest and
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

Correction-record export is unfinished, blocked on review#369/create#91. Existing
comments and feedback preserve reviewer wording, but are not a substitute for
that shared export or for create-owned structure decisions.

When `--project` and `--project-draft` select a recorded Create draft that declares its `config`, `parts`, `rig` and `check` directories, Stage 1 also enables the mesh correction instruments before a rig version exists while the draft is editable (`parts` or `parts-review` stage without an effective `parts-review` sign-off, and not `--view-only`). The status bar reports the recorded draft producer version as provenance alongside the installed producer and compiler versions; Apply runs the installed producer and compiler resolved by `resolveProducer` and its operation-capability floors (`REMESH_SINCE` and `REMESH_DELTA_SINCE`, plus `EDIT_PRODUCER_MISMATCH` if a patch's `producer` differs from the installed producer), without an equality version gate against the recorded draft producer. Opening an instrument switches to the Setup inspector for that mesh correction, while direct Stage 3 navigation stays refused with `RIG_VERSION_UNAVAILABLE`. When the project stage is outside `parts`/`parts-review`, an effective `parts-review` sign-off is already recorded, or `--view-only` is set, Stage 1 remains inspection-only (`draft.inspectionOnly: true`) and hides the correction instruments; omitting `--parts-verdict-dir` or viewing an applied scratch build keeps the Stage 1 parts verdict save/export controls read-only (`PARTS_VERDICT_READ_ONLY`) while leaving the correction instruments available on an editable draft.

### Declared-grid Difference

**Difference** in an individual part view reads the optional producer declaration
`painting_in_rig: {path, sha256, resample:"lanczos3-rgb-opaque"}` in `parts.json`.
The literal portable path resolves inside the package. Its PNG must be RGBA8,
alpha 255 and exactly `rig_size`; its bytes must match the declared SHA-256.
The artifact joins `source.files` and protected inputs. Original `--painting`
A/B and Overlay remain independent. Legacy manifests without the declaration
still open normally; Difference requests refuse `PARTS_DIFFERENCE_UNAVAILABLE`.

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
integer Threshold (0–255). Above-threshold cells are red with intensity equal
to the difference; others are black. Alpha-zero cells show the sentinel.
Invalid threshold input is refused and visibly restored to the last valid value.
There is no automatic approval or pass/fail verdict.

With Footprints enabled, a cell held at alpha > 0 by any overlapping later
part at the same integer rig coordinate is grey (128,128,128) and excluded
from the count. Off compares the selected part without decoding or sampling front
rasters. The selected part and any front parts sampled with Footprints on need
integer x/y, PNG dimensions equal to w/h, and native RGBA8 operands.
A nontransparent selected cell outside the rig grid or fractional placement
refuses `PARTS_DIFFERENCE_ALIGNMENT`; review never rounds placement or invents
edge coverage. Assembly remains a separate visual view.

Difference comments retain `view.comparison:{mode:"difference",opacity,threshold}`
and the existing footprints, background and cameras. Older part/overlay states
keep their two-field shape. The common viewport crop captures the displayed
comparison; the native crop keeps original RGBA. Save, reopen, restore, JSON
and issue Markdown retain this state, with source checks before use.

Named input refusals: `PARTS_DIFFERENCE_PROVENANCE`, `PARTS_DIFFERENCE_PATH`,
`PARTS_DIFFERENCE_HASH`, `PARTS_DIFFERENCE_PNG`, `PARTS_DIFFERENCE_SIZE`,
`PARTS_DIFFERENCE_ALPHA`. A changed loaded input uses
`PARTS_VIEW_SOURCE_CHANGED`. No producer command executes for Difference.
`tests/parts-difference.test.ts` supplies literal independent numeric controls;
`tests/parts-difference-browser.ts` exercises bilingual display and saved evidence.

Saved standalone part notes and pointed comments can be selected as described
corrections. The handoff keeps the part and original image evidence. Its Create
selector is a retained parts inventory, with no rig version.
See [Correction handoff](WORKFLOWS.md#correction-handoff).
