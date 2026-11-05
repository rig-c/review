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
is written), `--port <n>`. Like `review`, it serves in the foreground and exits 3 s after its last tab closes.

## Inputs

| Mode | Opens on | Items |
| --- | --- | --- |
| parts | a directory holding `parts.json` beside `parts/<name>.png`, as `rig-parts assemble` writes it, or a build root whose `rig/` holds them | every part, in `parts.json` order (draw order, back first) |
| atlas | a review package or build `check/` folder whose compiled model declares `pages[].regions[]` | every region, by page |

## What it shows

- **Every part on its own**, on a sentinel background (green, magenta, black, white or checker), at native scale with
  2× and 4× nearest-neighbour zoom. **Alpha only** shows the alpha channel as grey (white is opaque).
- **Footprints of parts in front** (parts mode): the alpha of every part later in `parts.json` whose box meets the
  selected part's box, placed by its rig box and tinted cyan at 50 %. Where the selected part has no pixel under its
  occluder, the tint lands on the bare sentinel, so a back part that stops exactly at its occluder's edge shows the
  occluder's shape at a glance. Nothing is measured; the tint is the front parts' own alpha.
- **Atlas mode**: the pages as packed, with each region's box and name; the background shows through padding, and a
  region's own view keeps 4 page pixels around its box (dashed) so bleed is visible. Clicking a region opens it.
- **Producer flags**, read from the files rig-parts writes and shown on the part they name. None is re-measured here. Each reads as one labelled line (an opening's parts, animation, frame and cells; a seam pair's pixel counts; a gate's name, status and readings), with the producer's object verbatim under a collapsed **Producer line**.

### Producer row groups

The sidebar reports separate source counts, for example **mesh 1 · check 4**, rather than a combined flag total.
Only sources actually read get a count; an absent report is never shown as zero. A part with no flags from any
read source has no count badge. Custom input filenames follow the same rule.
The selected part's rows sit under **mesh_report.json** and **check.json**, each with collapsed producer-root groups
and their row counts. Open a group to inspect its rows. A check headline includes its root, exact JSON path and
the row's own string fields (including pair names, part names, status and reason when present), followed by the
existing labelled readings. The enclosing block's status is labelled **Block**; a row's own `unavailable` does not
become `WARN` merely because its block warns. Producer field values and the raw object are never translated.

This is grouping by input source, **not classification of defects**. The existing extraction rules below are
unchanged: unavailable support rows, informational pair readings and unknown rows that the reader already
attributed remain present, counted under their source. One producer row can name multiple parts and appear on each;
counts are per-part attributions, not unique problems across a rig. No scope, finding/evidence kind or acceptance
verdict is inferred. Source hashes, saved flag ids and sign-off binding remain unchanged.

The public regression input [`parts-check-380.json`](https://github.com/rig-c/review/blob/main/tests/fixtures/parts-check-380.json)
is synthetic data, not a producer run or a private package. Its fields follow the producer's
[`SupportReport` / `SupportPair`](https://github.com/rig-c/parts/blob/main/src/coincide.ts),
[`MotionSeamLine` / `MotionSeamPair` and `LimbLine` / `LimbRow`](https://github.com/rig-c/parts/blob/main/src/check.ts).
Alongside the public planted parts package, it retains 1 mesh attribution and 11 check attributions: on the back
defect part **mesh 1 · check 4**, on the control **mesh 0 · check 2**, and on the front **mesh 0 · check 5**.
The fixture deliberately keeps unavailable support, pair and part rows together. DOM checks exercise collapsed
root counts, distinct same-part pair headlines, separate source badges and unchanged input hashes in both languages.

| Flag | Read from | When |
| --- | --- | --- |
| `faint:<i>` | `mesh_report.json` beside `parts.json` (`rig` writes it there): a row's `contour.bridges.faint[i]` | a faint island the mesh left out (rig-parts #326) |
| `check:<path>` | `check/check.json` beside `rig/` | a gate whose `status` is `FAIL` or `WARN` (not `PASS`, `CLEAR`, `SKIP` or `REPORTED`), or a `seam_pairs` / `figure_openings` entry, that names the part by a string field; bone fields (`bone`, `root`, `tip`, `link`) never attribute |

The occlusion-coverage report (rig-c/parts#998) is not read yet; the footprint toggle stands without it.

## The sign-off

Each item is **pending**, **clean** or **flagged** with a note (a note is optional on clean). **Save sign-off**
writes `parts-review.json` beside `parts.json` (atlas mode: beside the model), or to `--verdict`:

```json
{
  "schema": "rig-review-parts-verdict/1",
  "mode": "parts",
  "tool": { "name": "@rig-c/review", "version": "1.4.3" },
  "source": {
    "sha256": "…",
    "files": [{ "path": "parts.json", "bytes": 1234, "sha256": "…" }, { "path": "parts/hair_back.png", "bytes": 5678, "sha256": "…" }],
    "flags": [{ "path": "mesh_report.json", "sha256": "…" }]
  },
  "status": "pending",
  "parts": { "hair_back": { "outcome": "flagged", "note": "no material under the arm", "flags": ["faint:0"] } },
  "updatedAt": "2026-11-04T00:00:00.000Z"
}
```

- `mode` is `parts` or `atlas`. rig-c/create gates its `parts-review` stage on `parts` only.
- `source.files` is `parts.json` and every part PNG (atlas mode: the model and every page), each path **relative to the
  verdict file's directory**, POSIX separators. A part added, removed or repainted after sign-off changes the hash.
- `source.sha256` is the SHA-256 of the UTF-8 lines `<path>\t<sha256>\n`, one per `source.files` entry, sorted by path
  bytewise. Consumers recompute it from the files on disk.
- `source.flags` lists the producer files the flags were read from; `parts.<name>.flags` the flag ids shown on that part.
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
