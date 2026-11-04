# Parts and atlas view

`rig-review parts` shows a rig's parts as images, before any rig is built, so a part with missing material, a faint
island or a ragged rim is caught before rigging rather than in motion after it. The same view reads a built rig's atlas
to check what ships.

```sh
npx rig-review parts <out>            # a rig-parts build root: opens <out>/rig/parts.json
npx rig-review parts <out>/rig        # the same package, named directly
npx rig-review parts <out>/check      # a built rig's atlas (any review package with a compiled model)
```

Options: `--mesh-report <file>`, `--check <file>` (producer flags; see below), `--verdict <file>` (where the sign-off
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
- **Producer flags**, read from the files rig-parts writes and shown on the part they name. None is re-measured here.

| Flag | Read from | When |
| --- | --- | --- |
| `faint:<i>` | `mesh_report.json` beside `parts.json` (`rig` writes it there): a row's `contour.bridges.faint[i]` | a faint island the mesh left out (rig-parts #326) |
| `check:<path>` | `check/check.json` beside `rig/` | a gate whose `status` is not `PASS`, or a `seam_pairs` / `figure_openings` entry, that names the part by a string field; bone fields (`bone`, `root`, `tip`, `link`) never attribute |

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
when a file changed after the view opened. A saved sign-off made on other files is not offered when the view reopens.

Editing parts is out of scope: repairs go through the producer's source ladder, never the browser.
