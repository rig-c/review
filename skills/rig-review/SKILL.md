---
name: rig-review
description: Hand a rig build or rig-parts/rig-pose output to a person for local inspection and retrieve their structured feedback with rig-review (@rig-c/review). Validate the delivery package (rig-review check), start or reuse a loopback inspection workspace and print its capability URL (rig-review open), read back submitted verdicts, frame intervals, stage-comment crop PNGs and applied producer edits (rig-review feedback --format json|issue), export comparison or feedback frame strips headlessly (rig-review strip), or steer an opted-in open page (rig-review control). Not for compiling a rig (use rigc or rig-parts) or grading a rig without a person's submission.
license: MIT
compatibility: Requires Bun 1.3.0 or later on PATH. The canonical npm package is @rig-c/review (npm i -D @rig-c/review, or bun add -d @rig-c/review; rig-review is the convenience install name); the command it installs is rig-review, and @rig-c/play is installed as a dependency.
---

# rig-review — human inspection handoff and feedback retrieval

Load this when a rig or animation is **ready for a person to inspect**, or when
the person has submitted a review and you need to **read back what they asked to
change**. The workspace's reader is a person in a browser; this file states what
an agent can actually drive from the CLI, what only the person does, and where
every rule lives.

## What an agent drives vs. what the person drives

1. **Validate and hand off (agent):**
   ```sh
   npx rig-review check /absolute/path/to/output
   npx rig-review open /absolute/path/to/output [--reference /abs/video.mp4] [--compare /abs/other] [--animation <name>] [--config /abs/config.json [--parts <dir>] [--source <png> --full <dir> [--head <dir>]] [--keypoints <file>]] [--control]
   ```
   `check` verifies the delivery contract and source SHA-256 without starting a
   server. `open` starts or reuses a loopback worker behind the managed front
   (`127.0.0.1:4318`, or `--direct`), prints the writable `#cap=…` URL alone on
   stdout for the person to open, and prints the exact matching
   `rig-review feedback …` command on stderr — [Owner handoff](https://github.com/rig-c/review/blob/main/docs/WORKFLOWS.md#one-command-owner-handoff).
2. **Inspect, rebuild in scratch and submit (person in the browser):**
   `rig-review` never opens a browser itself. Only the person holding the
   `#cap=…` tab can inspect panels, run `Apply · Rebuild` through the installed
   producer (`rig-parts`, `rig-pose`) into scratch, place, read or edit **Comment · C (n)** crops,
   choose **approved** or **changes-requested** in **Write review**, and click
   **Submit review** — [Feedback ownership](https://github.com/rig-c/review/blob/main/docs/WORKFLOWS.md#feedback-ownership).
3. **Act on what comes back (agent):**
   ```sh
   npx rig-review feedback /absolute/path/to/output [...same flags as open...] [--format json|issue]
   npx rig-review strip /absolute/path/to/output --reference-video /abs/video.mp4 --animation <name> (--frames FIRST:LAST | --all-feedback) [--json] [--out /abs/outside/strip.png]
   ```
   Read `status` (`pending` means the person has not submitted yet; opening
   never approves), `reviewedSource` (rig/motion SHA-256 and tool versions),
   `applied` (the exact config patches, pose-map/retarget flags and producer
   lines the person applied in scratch), `feedback` (inclusive frame intervals,
   bone/slot/rig targets, `defect`|`quality` category and summary), and
   `comments` (pin/box coordinates, nearest drawn slots, and derived crop PNG
   paths under `~/.local/state/rig-c-review/` that you can open directly without
   a browser). Apply the requested fixes in the upstream producer (`rig-parts`,
   `rig-pose` or `rigc`), rebuild, and run `rig-review open` again.
4. **Optional live view steering (agent, only while the person's tab is open):**
   When opened with `--control` and a browser tab is connected,
   `npx rig-review control <dir> [...same flags...] [--page <id> --expected-revision <n> --request-id <id> --command <JSON>]`
   reads or steers camera, time, animation and layers; it cannot submit or
   approve a review or mutate source files — [Control](https://github.com/rig-c/review/blob/main/docs/WORKFLOWS.md#control-the-current-inspection-page).

## Non-negotiables

- **Supplied packages and models stay immutable.** Review never edits
  `motion.json`, `skeleton.model.json` or source art; producer edits run in
  scratch and feedback is stored under `~/.local/state/rig-c-review/` (or
  `RIG_REVIEW_STATE_DIR` outside every input package) bound to the exact content
  SHA-256 — [REVIEW_PACKAGE.md](https://github.com/rig-c/review/blob/main/docs/REVIEW_PACKAGE.md).
- **Pass the exact handoff flags to `feedback` and `control`.** `--reference`,
  `--compare`, `--animation` and `--config` (`--parts`, `--source`, `--full`,
  `--head`, `--keypoints`) are hashed into the session identity; omitting one
  reads a different session, and changing any input byte starts a fresh
  `pending` session — [WORKFLOWS.md](https://github.com/rig-c/review/blob/main/docs/WORKFLOWS.md#one-command-owner-handoff).
- **Never leak the `#cap=` fragment into public logs or commits.** The fragment
  is the per-instance 256-bit write capability; share it only with the person
  reviewing on the local machine — [Managed front](https://github.com/rig-c/review/blob/main/docs/WORKFLOWS.md#managed-front-and-write-capability).
- **Strip outputs go outside every input package.** `rig-review strip --out`
  refuses a path inside any reviewed package and requires `frameTimes` in the
  report plus `ffmpeg` (≥ 5.1) and `ffprobe` on `PATH` for PNG video decoding —
  [Frame strip export](https://github.com/rig-c/review/blob/main/docs/WORKFLOWS.md#frame-strip-export).

## Read, in this order

1. [docs/WORKFLOWS.md](https://github.com/rig-c/review/blob/main/docs/WORKFLOWS.md) —
   `open`, `check`, `compare`, `feedback` (`--format json|issue`), `strip`,
   `control`, the launcher stdout/stderr/exit-code contract and `OPEN_*` /
   `FRONT_*` refusal codes.
2. [docs/REVIEW_PACKAGE.md](https://github.com/rig-c/review/blob/main/docs/REVIEW_PACKAGE.md) —
   folder discovery (`skeleton.model.json`, `build/skeleton.model.json`, and
   `rig-parts build` roots), `review.json`, producer handoff (`HANDOFF_*`),
   session/feedback schema and historical retrieval.
3. [docs/PANELS.md](https://github.com/rig-c/review/blob/main/docs/PANELS.md) and
   [docs/ANIMATION_INSPECTION.md](https://github.com/rig-c/review/blob/main/docs/ANIMATION_INSPECTION.md) —
   what each browser panel writes into `applied`, `feedback` and `comments`.

Every guide linked above ships in the installed package under
`node_modules/@rig-c/review/docs/`, matching the installed version.
