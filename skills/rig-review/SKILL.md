---
name: rig-review
description: Hand a rig build or rig-parts/rig-pose output to a person for local inspection and retrieve their structured feedback with rig-review (@rig-c/review). Validate the delivery package (rig-review check), guide a person through parts and mesh, the Create choice interview, rig and animation, and direction, start or reuse a loopback inspection workspace and print its capability URL (rig-review open), read back submitted verdicts, frame intervals, stage-comment crop PNGs and applied producer edits (rig-review feedback --format json|issue), export comparison or feedback frame strips headlessly (rig-review strip), or steer an opted-in open page (rig-review control). Not for compiling a rig (use rigc or rig-parts) or grading a rig without a person's submission.
license: MIT
compatibility: Requires Bun 1.3.0 or later on PATH. The canonical npm package is @rig-c/review (npm i -D @rig-c/review, or bun add -d @rig-c/review; rig-review is the convenience install name); the command it installs is rig-review, and @rig-c/play is installed as a dependency.
---

# rig-review — human inspection handoff and feedback retrieval

Use this to hand separated parts, a rig or a post to a person for inspection,
or to read back their submitted review.

## What an agent drives vs. what the person drives

Use the installed CLI. For compiled packages, run `rig-review check <package>`
before handoff to validate the package and read its source SHA-256. Use managed
`rig-review open` for joined inspection and embedded saves. Give the reviewer
its URL from stdout privately and keep the exact feedback command from stderr.
The stage buttons navigate within that source binding.

1. **Parts + mesh.** Open the recorded Create draft's compiled check directory.
   The picks and verdict directories must already exist inside the project,
   separate from its inputs.
   ```sh
   rig-review open <draft-check-dir> --project <project> --project-draft <id> --picks-dir <picks-dir> --parts-verdict-dir <verdict-dir>
   ```
   The person inspects separated parts and their mapped draft meshes, leaves
   notes or described corrections, and inspects scratch results when available.
   Mesh Apply requires an eligible handoff and an installed producer that
   supports the declared operation. If Apply is unavailable, report the named
   refusal. Read the **Save sign-off** verdict from the designated directory,
   including the original source binding, part and mesh outcomes and notes. Keep it at its saved location. An approved,
   current verdict is evidence for Create's `parts-review` sign-off. Draft
   geometry is structure evidence. Without a
   compatible draft, `rig-review parts <parts> --verdict <output-file>` provides
   standalone inspection and named limits on direct correction.
2. **Interview.** In the joined draft workspace choose **2 Interview**. For
   choices bound to a recorded rig, open its package with the Stage 3 command.
   The standalone entry is `rig-review interview <project> --picks-dir <picks-dir>`.
   Beside the bound parts or source image, the person chooses among the saved
   options with the agent's recommendation and rationale, then uses
   **Save explicit picks**. Read the `rig-review/interview-picks@1` file for the
   exact question set, including the person's picks and note. Ingest it in
   Create for the `rigging-interview` or `post-interview` sign-off as appropriate.
   Other and Auto can remain pending. Follow [Create's interview guide](https://github.com/rig-c/create/blob/main/docs/INTERVIEW.md).
3. **Rig + animation.** Open the recorded rig version's materialized package
   and choose **3 Rig + animation**.
   ```sh
   rig-review open <rig-package> --project <project> --project-version <rig> --picks-dir <picks-dir>
   ```
   The person inspects setup and motion, marks details with **Comment · C (n)**,
   and can Apply · Rebuild supported edits through the installed producer in
   scratch. They choose **approved** or **changes-requested** and submit in
   **Write review**. Run the printed feedback command with `--format json`.
   Read the status, reviewed source and tool versions, frame intervals and
   targets, comments and crop paths, and recorded Apply data. Inspect the
   actual producer check and named refusals even if the UI shows a rebuild or
   an applied badge. Report which clip, frames and edits were actually verified.
   The submitted feedback informs the versioned Create verdict and
   `rig-review` sign-off.
4. **Direction.** Open the rig package with the post that explicitly names
   that rig and binds its authored direction.
   ```sh
   rig-review open <rig-package> --project <project> --project-version <rig> --picks-dir <picks-dir> --post-version <post>
   ```
   In **4 Direction**, the person reviews framing, depth and timing, inspects
   authored camera keys and timing read-only, and submits their decision or
   described correction for the selected post. Camera Apply is
   `CAMERA_APPLY_UNSUPPORTED`. Read back the submitted feedback with the printed
   command and match the post, direction and model bindings before handing it
   to Create for that version's verdict and `direction-review` sign-off.

Create owns answer ingestion, review verdicts and signatures. Follow
[Create's sign-off contract](https://github.com/rig-c/create/blob/main/docs/PROJECT.md#recording-a-sign-off)
and [version targets](https://github.com/rig-c/create/blob/main/docs/PROJECT.md#targets-of-review-signatures).
Opening, navigating and saving Review records confer no Create authority.

## Correction readback

In **Write review**, the person marks the feedback as described or made under
**Correction handoff**, supplies the Create selector, and submits. Look for an
explicit `context.correction` in submitted feedback. Its selector
must identify the Create draft, rig or post. For a post it also carries the
model path. Use the printed `rig-review feedback` command, preserving its
handoff arguments, and append `--correction <item-id> --format issue` for the
selected handoff or `--correction <item-id> --format json` for the saved session.

- **Described.** Read the exact words, source selector and inspection context.
  Standalone parts notes and comments instead use
  `rig-review parts <parts> --verdict <output-file> --correction <item-id> --parts-file <inventory> --format issue`.
  Add `--part-note <part>` for a part note. Preserve the words byte for byte and
  hand the request to Create as open. For authored direction verify the exported
  `createSource` against the selected post, direction and model before import.
  Address the request upstream, rebuild, and return the new revision for review.
- **Made.** Read the selected item's `context.applied` and retain the exact
  session and item ID. Check the producer line, input and result bindings and
  actual check before claiming a checked scratch result. Require exit zero, a
  passing gate and at least one PASS bar. Report missing, stale or failed
  evidence with its refusal. For an unsupported operation, retain the original
  evidence and named refusal. For a supported checked handoff, record it in
  Create as pending, then reproduce the edit through the producer on the bound
  inputs and verify the resulting revision. A pending record supplies no closure or
  acceptance.

Follow [Review's correction handoff](https://github.com/rig-c/review/blob/main/docs/WORKFLOWS.md#correction-handoff),
including the [authored direction binding](https://github.com/rig-c/review/blob/main/docs/REVIEW_PACKAGE.md#correction-handoff),
and [Create's correction contract](https://github.com/rig-c/create/blob/main/docs/PROJECT.md#correction-paths-described-and-made).

## Non-negotiables

- **Supplied packages and models stay immutable.** Review never edits
  `motion.json`, `skeleton.model.json` or source art. Producer edits run in
  scratch. Keep every input unchanged, including producer config, parts,
  requirements and authored animation files. Use dedicated output paths for
  picks, verdicts and exports. A verdict destination must never alias an input
  through a symlink or hard link (`PARTS_VERDICT_INPUT_COLLISION`). Feedback
  binds to the exact content SHA-256 and stays under `~/.local/state/rig-c-review/`
  (or `RIG_REVIEW_STATE_DIR` outside every input package) — [REVIEW_PACKAGE.md](https://github.com/rig-c/review/blob/main/docs/REVIEW_PACKAGE.md).
- **Keep the exact handoff inputs for `feedback` and `control`.** Reuse the
  printed lookup arguments, including reference, comparison, animation,
  producer and joined Create selectors as applicable. A changed bound input
  needs a fresh session. `pending` conveys no approval.
- **Never leak the `#cap=` fragment into public logs or commits.** The fragment
  is the per-instance 256-bit write capability; share it only with the person
  reviewing on the local machine — [Managed front](https://github.com/rig-c/review/blob/main/docs/WORKFLOWS.md#managed-front-and-write-capability).
- **Strip outputs go outside every input package.** `rig-review strip --out`
  refuses a path inside any reviewed package and requires `frameTimes` in the
  report plus `ffmpeg` (≥ 5.1) and `ffprobe` on `PATH` for PNG video decoding —
  [Frame strip export](https://github.com/rig-c/review/blob/main/docs/WORKFLOWS.md#frame-strip-export).

## Optional CLI and references

- With `rig-review open <package> --control` and the person's tab connected,
  `rig-review control <package>` with the same binding arguments reads or
  steers the inspection view. The person retains submission authority.
  [Control](https://github.com/rig-c/review/blob/main/docs/WORKFLOWS.md#control-the-current-inspection-page).
- `rig-review strip <package> --reference <declared-video-id> --animation <name> --frames FIRST:LAST --out <new-png>`
  exports an inclusive interval. Use `--all-feedback` in place of `--frames`
  for saved intervals, or `--json` for the selection/provenance plan.
  [Frame strip export](https://github.com/rig-c/review/blob/main/docs/WORKFLOWS.md#frame-strip-export).
- Read [WORKFLOWS](https://github.com/rig-c/review/blob/main/docs/WORKFLOWS.md)
  for launcher and refusal details, [REVIEW_PACKAGE](https://github.com/rig-c/review/blob/main/docs/REVIEW_PACKAGE.md)
  for source and feedback bindings, and [PANELS](https://github.com/rig-c/review/blob/main/docs/PANELS.md)
  for inspection controls. Review guides ship under `node_modules/@rig-c/review/docs/`.
