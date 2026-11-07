---
name: rig-review
description: Hand a rig build or rig-parts/rig-pose output to a person for local inspection and retrieve their structured feedback with rig-review (@rig-c/review). Validate the delivery package (rig-review check), guide a person through parts and mesh, the Create choice interview, rig and animation, and direction, start or reuse a loopback inspection workspace and print its capability URL (rig-review open), read back submitted verdicts, frame intervals, stage-comment crop PNGs and applied producer edits (rig-review feedback --format json|issue), export comparison or feedback frame strips headlessly (rig-review strip), or steer an opted-in open page (rig-review control). Not for compiling a rig (use rigc or rig-parts) or grading a rig without a person's submission.
license: MIT
compatibility: Requires Bun 1.3.0 or later on PATH. The canonical npm package is @rig-c/review (npm i -D @rig-c/review, or bun add -d @rig-c/review; rig-review is the convenience install name); the command it installs is rig-review, and @rig-c/play is installed as a dependency.
---

# rig-review — human inspection handoff and feedback retrieval

Use this to hand separated parts, a rig or a post to a person for inspection,
or to read back their submitted review.

## Active cycle standing live-job contract

For the active Create and Parts cycle, the authoritative contract is `src/job-contract.ts` (`JOB_API_SCHEMA` set to `rig-review/job-api@1`, `JOB_ACT_SCHEMA` set to `rig-review/act@1`, [Review #484](https://github.com/rig-c/review/issues/484)), backed by the implemented backend session/store (`src/job-session.ts`, `src/job-source.ts`, `src/job-act.ts`, `src/job-api.ts`), standing loopback job front and browser window runtime (`src/job-front.ts`, `web/job-session.ts`), and `rig-review session` CLI (`src/entry.ts`, `src/job-cli.ts`). Public package exports remain `./package.json` only until the public installed managed-host export lands in [Review #489](https://github.com/rig-c/review/issues/489), and Create's production publication reader and writer-owned sibling `fetch-act` readback remain pending [Create #184](https://github.com/rig-c/create/issues/184) (publishing a Create root containing `project.json` without a host `readPublished` callback refuses `JOB_SOURCE_UNRETAINABLE` with `CREATE_PUBLICATION_CONTRACT_UNAVAILABLE`). Do not invent public export names, producer scene fields or unimplemented flags, and never expose capabilities in reports or logs. See [Live job contract](https://github.com/rig-c/review/blob/main/docs/REVIEW_PACKAGE.md#live-job-contract) and [Standing live job workflow](https://github.com/rig-c/review/blob/main/docs/WORKFLOWS.md#standing-live-job-workflow).

Exact CLI namespace (`src/entry.ts`, `src/job-cli.ts`; `publish`, `ask`, `next`, `close` also accept optional `--request-id <id>`):

```text
Usage: rig-review session open <root>
       rig-review session publish <job-url> --generation <n> --key <id> --result <relative-path> --freeze-hold <id> [--selector <JSON>] [--record <path> --record-hash <sha256>]
       rig-review session ask <job-url> --generation <n> --key <id> --publication <id> --subject <JSON>
       rig-review session next <job-url> [--after <cursor>] [--wait-ms <n>]
       rig-review session close <job-url> --generation <n> --key <id> --reason <words>
```

`rig-review session open <root>` requires `RIG_REVIEW_JOB_REVIEWER_ID` and `RIG_REVIEW_JOB_REVIEWER_ROLE` (`owner` or `delegate`), accepts optional `RIG_REVIEW_JOB_PORT` (`0..65535`), and optionally writes one private `{jobId, origin, agentCapability}` JSON line to descriptor `RIG_REVIEW_JOB_AGENT_FD` (`>= 3`) before printing the owner URL on stdout. A new listener stays in the foreground until `SIGINT`/`SIGTERM` or explicit `close`; run follow-up agent verbs in a second terminal with `RIG_REVIEW_JOB_AGENT_CAPABILITY` (`Authorization: Bearer …`). Ordinary non-Create package launch, bootstrap and explicit close example:

```sh
# Terminal 1 — create a private bootstrap directory (umask 077) and keep session open in the foreground:
boot=$(umask 077 && mktemp -d)
RIG_REVIEW_JOB_REVIEWER_ID=owner-1 \
  RIG_REVIEW_JOB_REVIEWER_ROLE=owner \
  RIG_REVIEW_JOB_AGENT_FD=3 \
  rig-review session open /absolute/path/to/work-root 3>"$boot/bootstrap.json"

# Terminal 2 — with RIG_REVIEW_JOB_AGENT_CAPABILITY set privately from $boot/bootstrap.json:
rig-review session publish http://127.0.0.1:<port>/jobs/<job-id> \
  --generation 0 --key pub-1 --result package --freeze-hold hold-1 \
  --selector '{"kind":"rig","version":1}'
rig-review session ask http://127.0.0.1:<port>/jobs/<job-id> \
  --generation 1 --key ask-1 --publication <publication-id> \
  --subject '{"kind":"review-verdict","stage":"rig-review"}'
rig-review session next http://127.0.0.1:<port>/jobs/<job-id> --wait-ms 5000
# Pass the current generation returned by next (human UI acts advance generation):
rig-review session close http://127.0.0.1:<port>/jobs/<job-id> \
  --generation <current-generation> --key close-1 --reason "inspection complete"
```

- **One standing Review window and visual gate.** Every owner visual, question, choice, correction and verdict goes through one standing Review window/link plus one what-to-look-at line. Internal agent and HQ media stay internal. A missing required visual (`visual.status` set to `'unavailable'`) is an immediate stop plus a Create-filed on-path Review card, never a chat fallback.
- **Human UI vs agent verbs.** People submit through the Review UI (`actor` set to `'human'`, `channel` set to `'review-ui'`). Trusted host bootstrap declares `reviewer` (`id` and `role` as `'owner'` or `'delegate'`), which the browser UI cannot type or override (declared provenance, not keyboard authentication, mapped by Create to its `by` authority). Agents use only `publish`, `ask`, `next` and `close` with `expectedGeneration` CAS and `idempotencyKey` on mutations.
- **Explicit producer-held freeze and explicit close.** Every `publish` carries an explicit producer-held freeze (`freeze.kind` set to `'producer-held'`, `holdId`, `record` as `JobFileIdentity` or `null` for a declared non-Create root) held until acknowledgment as a caller obligation. Review validates retained bytes, detects a moved record and commits local generation CAS. No watched-root or automatic-close guarantee exists, and only explicit `close` ends an active job.
- **Exact displayed source, cursor replay and draft retention.** `next` (`after` cursor and bounded abortable `waitMs` that never consumes an act) replays complete durable `JobEvent` items (`published`, `pending`, `act`, `closed`). The daemon derives `JobSourceBinding` from validated retained bytes and the page-scoped `displayedNonce` receipt rather than browser-supplied hashes. When a new publication replaces or updates the displayed source, old local drafts remain retained for their original source binding and are flagged without rebinding onto the new publication.
- **Five enabled act kinds and two reserved disabled kinds.** Enabled kinds are `interview-picks`, `checkpoint`, `parts-verdict`, `review-verdict` and `signoff`. Reserved kinds `described-correction` (awaiting the joint [Create #182](https://github.com/rig-c/create/issues/182) context allowlist) and `mesh-edit` (awaiting the joint [Parts #1159](https://github.com/rig-c/parts/issues/1159) freeze) stay disabled (`JOB_ACT_KIND_DISABLED`) and cannot be asked or submitted.
- **Checkpoints, signoffs, plan steps and parts PNGs.** Finalized `checkpoint` acts carry `outcome` `'pass'` or `'fail'` only (`'pending'` stays in the UI draft), require `words` as a string preserved verbatim including empty or whitespace-only text, copy `planStepId` from the validated ask on the daemon while the browser sends `checkpointId`, `outcome` and `words` only, and leave stage derivation to Create (only `'pass'` is eligible for Create's checkpoint sign-off writer). Finalized `signoff` acts carry `decision` `'approved'` only with required `words` preserved verbatim including empty or whitespace-only text, remain separate from verdicts and Create stage transitions, and require `source.plan` with exact displayed step IDs and hashes published by [Create #184](https://github.com/rig-c/create/issues/184) (without Review recomputing `stepHash`) on `plan-approved`, `rigging-interview` and `post-interview`. In the current C3 runtime, `JobPartsIdentity` is limited to its declared four roles (`part`, `alternate`, `depth`, `painting`) and path restriction — normal `parts/*.png` images plus exact `painting_in_rig.png` beside `parts.json` (root or project prefix only) — so `figure_mask` is missing and C3 is not yet a complete manifest-referenced parts PNG inventory. C4 ([Review #501](https://github.com/rig-c/review/issues/501)) is queued to bind the `@rig-c/parts` `2.25.0` `partsFileReferences` result per Parts `STABILITY` at `62208d6` ([Parts #1163](https://github.com/rig-c/parts/issues/1163)) together with [Create #184](https://github.com/rig-c/create/issues/184), which owns the roles without a Review field parser. Within the current C3 set, changed or missing referenced bytes (including a referenced `painting_in_rig.png`) invalidate the binding while unreferenced stale extras are excluded.
- **No agent file carriage, writer-owned sibling fetch and internal host seam.** Agents never build, parse, reshape or carry Review session, picks, verdict or applied-record storage files. [Create #182](https://github.com/rig-c/create/issues/182) and [Create #184](https://github.com/rig-c/create/issues/184) own direct writer publication and `fetch-act` reads using a private writer-owned sibling binding outside `project.json` (`writer-owned-sibling-fetch-capability`, pending Create #184 production reader/writer integration) that is never tracked in version control or unstaged project output, dies at explicit `close` and receives a new grant on each job incarnation. In the internal managed-host startup seam (`startJobHost` in `src/job-front.ts`, kept internal until [Review #489](https://github.com/rig-c/review/issues/489)), hook-bearing host callers declare `readerId` and `bindingId`; equality governs listener reuse and missing or mismatched IDs refuse by name (`JOB_HOST_OPTION_ID_INVALID`, `JOB_HOST_REUSE_MISMATCH`) with no function hashes. Future mesh acts will be fetched by Create and passed in process to Parts' public exported API owned by [Parts #1159](https://github.com/rig-c/parts/issues/1159) without Parts reading Review or Create storage, while standalone `--delta` remains legacy outside this cycle.
- **Direction metadata vs playback.** Direction carriage in `#484` is metadata-only (`source.direction` and `direction-review`) and is distinct from [Review #482](https://github.com/rig-c/review/issues/482) preview and [Review #483](https://github.com/rig-c/review/issues/483) actual plated take playback, while [Review #373](https://github.com/rig-c/review/issues/373) stays parked.

## What an agent drives vs. what the person drives

The one-shot CLI file-handoff instructions in this section and in Correction readback below (`--picks-dir`, `--picks-file`, `--parts-verdict-dir`, `--verdict`, `--correction`, reshaped feedback JSON and `--verbatim-file`) are preserved as legacy/history compatibility for standalone and historical runs. Using those file handoffs in the active standing live-job cycle is a bypass finding ([Create #182](https://github.com/rig-c/create/issues/182), [Create #184](https://github.com/rig-c/create/issues/184)).

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

In the active standing live-job cycle ([Active cycle standing live-job contract](#active-cycle-standing-live-job-contract), [Create #182](https://github.com/rig-c/create/issues/182), [Create #184](https://github.com/rig-c/create/issues/184), [Parts #1159](https://github.com/rig-c/parts/issues/1159)), `described-correction` and `mesh-edit` remain reserved disabled act kinds (`JOB_ACT_KIND_DISABLED`), and agents never build, parse, reshape or carry Review session, feedback, applied-record or verbatim files. The `--correction`, `--verdict`, reshaped feedback JSON and `--verbatim-file` flow below is preserved as legacy/history compatibility and is a bypass finding if used in the active cycle.

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
