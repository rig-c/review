# Workspace panels

See [inspection workflows](WORKFLOWS.md) for opening, comparison and feedback, or [Start](../README.md#start) for installation.

## Workspace settings and panels

The review page has a left column (Parts explorer, with checkpoints and the
reference select folded above it), the stage, the Inspector below it with
**Setup** and **Animate** sections, and a status footer. The compare page
keeps sources on the left and the Parts explorer on the right. The page
header carries the **Setup · Animate · Compare** mode switch next to the package
title. In a single-build session (`rig-review open <built>`), **Compare** is
disabled with a tooltip explaining that a second build and reference video are
required (`--compare <built> --reference <video>`). In a comparison session, the
page starts in **Compare** mode with Reference, Build A and Build B side by
side, and switching to **Setup** or **Animate** keeps time, animation and
selection while exposing the **Editing Build A / Build B** picker so the shared
Setup and Animate panels operate on the picked build only. Setup is the
mesh-review composition (selected part, part presets, modeling-review
proposals) and holds nothing that seeks or plays; the angle inspection, the
transport and frame navigation are in Animate. **Write review** at the top
right opens the review dialog, a modal holding the review status, reviewed
source, selected checkpoint, structured feedback and frame-strip export, with
its own **Submit review**. Escape or Close dismisses it and returns focus to
**Write review**; the draft keeps saving whether the dialog is open or not,
and the footer and the dialog both show its state.
The left column's header (Parts title and search) stays fixed at the top;
the checkpoint strip, the part list and Settings scroll beneath it as one
body. A drawer keeps its title and close button in place while its body
scrolls. The per-inspection **Repeat idle** toggle sits in the Animate
transport row.

Animate's **Environment** block drives the player's physics while you
inspect: a **Wind** base (−100…100), **Breeze**, a **Gust** pulse
(peak 0…200, duration 0.1…20 s, **Repeat** every max(6, duration + 0.6) s)
and **Gravity** (0…4), applied through `player.environment` in the same frame
step that draws. The gust clock is the stepped player time, so pausing freezes
it. **Jolt** sends a translate-and-return impulse through `player.moved`;
with **Drag to trail** on, dragging the rig pane moves the rig's physics
instead of the camera (Space still pans). **Reset physics** returns the
runtime start values and re-poses from the current time, clearing the physics
history. Until a control is touched the player stays at the runtime start values. The
state is kept in the local draft and recorded in feedback as
`context.environment`; nothing is written to the model or motion. The compare
page does not have this block.

Below it, the **Physics tuning** panel (`#physics-panel`) edits the physics
constraints through the producer. Each row is a constraint of the inspected
model, matched to the handoff config's `constraints[]` entry of the same name
and kind; a row is editable only when every field the panel edits reads the
same on both sides. Rows the model has and the config does not declare (the
rig stage's `turn` twins), the config's transform constraints and any row that
does not map 1:1 are listed under **Not editable** with the reason. Picking a
row opens its editor: a slider and number field for each of `strength`,
`damping`, `inertia`, `mass`, `wind`, `gravity` and `mix` the config declares,
and toggles for the `x`, `y` and `rotate` components (0 is off). A **Chain**
(from bone parentage: links on parent bones that move the same components;
pick one from the list or with **Pick on stage**) takes a **Ramp**: one value
per link, linear from root to tip. Every edit is a config patch op at
`/constraints/<i>/<field>` that also records the constraint's `name`; the
pending ops are listed with a per-op **Revert** and kept in the local draft.
**Apply** sends them as one patch (`rig`, then `check`, about 20–50 s on a real
package); the scratch build reloads under the same wind, gust, jolt and gravity
state Apply was pressed in, and the readout shows the `ANIMATIONS_DO_NOT_FOLD`
and `TEXTURE_STRETCH` lines before and after. BEFORE for the inspected build
is its own check: once the baseline reproduces, review runs `rig-parts check`
on that baseline output in the background (about 16 s on a real package) and
stores the summary beside the baseline record, so a reload reads it; until it
finishes the line says "check running…", a producer refusal is shown verbatim,
and "not in check summary" remains only when the baseline did not reproduce. A
refusal is the producer's line verbatim (`CONFIG_CONSTRAINT_*`,
`CONFIG_NAME_RESOLVES`, rigc's `A23` for a mass of 0) and the stage is
unchanged. **Reset** returns to the inspected build and clears the pending ops.
Submit refuses a review written on an applied build whose check failed
(`EDIT_SUBMIT_UNCHECKED`).

With pinned published Play **1.14.0**, **Preview pending physics** previews
`strength`, `damping`, `inertia`, `wind`, `gravity` and `mix` through the live
player's public `setPhysicsParameters` / `readPhysicsParameters` /
`clearPhysicsParameters`. Slider input updates the standing patch while dragging;
the label separates the pending override from the last evaluated effective values.
The next evaluation uses it after authored keys and sliders, before physics. While
paused, the page explicitly re-poses the held time and draws; it never seeks or
resets history to preview. `mass` and `x` / `y` / `rotate` stay Apply-only.
**Clear preview** disables preview and removes its overrides, keeping the pending
ops and their Apply bytes. Authored values resume on the next evaluation; the
integrated history is retained, so clearing does not undo motion caused earlier.
Apply and a model replacement clear the preview; Reset clears both preview and
pending ops. Preview state is never recorded as applied or submitted.

Play retains the current standing patch across play and seek, with no history of
patch changes. A backward seek after an edit recomputes the past using the patch
standing now, rather than reproducing the old trajectory. A newly opened track
first evaluates its ordinary authored pose, then receives the patch as pending;
at seek time 0 its effective values can therefore still be authored until the next
evaluation. No live track means a named refusal; preview never creates one.

Below it, the **Idle tracks** panel (`#idle-tracks`) edits the idle through
the producer. It lists the handoff config's `motion.tracks`: a single track
opens amp, period, phase and base (base can be added or taken out); a chain
track opens one amp per link and lag, and draws a handle at each link on the
stage (drag up or down; arrow keys step 0.05°). Period is a select of the
divisors of `motion.duration` (`duration / 1 … 12`) — the only periods the
producer accepts — beside a field for typing one, which review's pre-check
refuses with the producer's own line (`CONFIG_PERIOD_DIVIDES_DURATION`). A
track is added by bone + property or by chain (it starts still: amplitude 0,
the whole idle's period) and removed with **Remove**; a second track on a
property already keyed (a chain link's `rotate`, a blink member) is refused
before Apply by the producer's `CONFIG_BONE_PROPERTY_KEYED_ONCE`. The blink's
`t` is a marker above the transport scrub, dragged along the timeline (arrow
keys step one 12 fps frame), with `squash` and `brow_drop` sliders. The
pending ops (`/motion/tracks/<i>/…`, `/motion/blink/…`) are listed with a
per-op **Revert** and kept in the local draft. While edits are pending the
**preview** drives the edited bones through the player's `adjust` with the
producer's sine on the bone the idle keys (`<bone>_ctl` under ctl keys, read
off the handoff rig). It evaluates from Play's `BoneAdjust` context's
`trackTime`, including seek replay, and the turn dial receives the same context.
It reads no displayed player clock and adds no compensating re-pose after seek.
With unchanged patch, animation, environment, reset and step partition, seek and
continuous evaluation agree bit for bit. It is labelled "preview — Apply decides"; it is never
recorded or submitted, and a property the inspected idle does not key yet is
not previewed (`IDLE_PREVIEW_TARGET_UNKNOWN`). **Apply** clears the preview and
sends one patch (`rig --idle-keys <the inspected rig's>`, then `check`, about
30 s on a real package); the built idle replaces the preview, and the
readout shows the `CHAIN_LAG`, `TIP_OVER_ROOT` and `BREATH_VISIBLE` lines and
check's `loop:` line before and after. **Reset** clears the preview and the
pending ops and returns to the inspected build.

Below that, the **Readings** block (`#readings`) runs the compiler's own
readings of the drawn animation: a **Folds** toggle, a **Pass-through**
cloth:leg pair and a **Seam** slot:slot pair (slot names suggested from the
model), an **Overlaps** toggle and an **Angle range** bone against a relative
bone. **Run readings** sends the chosen readings (names only) to
`POST /api/readings`; the server runs one `rigc render --animation <drawn>
--folds | --pass-through <cloth>:<leg> | --seam <a>:<b> | --overlaps |
--angle-range <bone>:<relative>` per reading on the inspected build and on the
latest scratch build of the session (if an Apply built one), into scratch
under the state directory (`readings/<package>/<build>/<key>/`; an identical
reading on the same build and compiler is reused; about 0.5–5 s each on a real
package). The frames each reading's JSON lists become ticks under the
transport scrub — inspected above, scratch below, in two colours — and
clicking a tick seeks to that frame's time (frame / fps). Each reading gets a
worst-frame line, `<build> · <reading> <pair>: worst at frame N — <figure> ·
<rigc's line>`, which also seeks; folds and overlaps list each folding mesh or
moving pair under it. `--angle-range` writes no file, so its ticks are the
lowest and highest frames its printed line names. An unknown slot or bone is
rigc's to refuse, and its line is shown verbatim. While the Environment
controls are applied, their current wind and gravity go along as a one-step
`--environment` schedule (only when the installed rigc's `render --help` lists
the flag). A reading is not a gate; nothing is written into the package. The
pairs of the last run are recorded in feedback as `context.readings`.

In the Environment block, **Use for readings** (issue #112) turns the controls
into a `rigc-environment/1` schedule from the clip's first frame — one step when
the wind is steady, else one step per 12 fps frame carrying the breeze and the
repeating gust (equal to the panel's wind at every frame time; between frames
rigc holds the frame's value, and the panel states how far that can be from the
live wind) — and sends it with readings and with Apply, whose check then runs
`rig-parts check --environment`. The wind clock restarts with the clip, so what
you watch is the world the readings and bars are taken in. **Export schedule**
downloads the same bytes; **Check under this world** runs `rig-parts check
--environment` on the build on the stage (needs `@rig-c/parts` 1.48.0) and shows
its `ANIMATIONS_DO_NOT_FOLD` and `TEXTURE_STRETCH` lines beside the same build's
default-world check. A refused schedule (`CHECK_ENVIRONMENT`) is shown verbatim.
Feedback records the schedule's bytes and sha256 as `context.environmentSchedule`;
nothing is authored into the rig.

Below Readings, the **Requirements** block (`#requirements`) declares what the
scene asks of the motion (issue #113): pick a kind (contact, follow, aim,
range, stretch, seam), an animation and the subject — the slot picked on the
stage pre-fills the slot, its mesh attachment and its bone — then set each
bar on a slider whose track marks the last measured value. **Check** sends the
typed requirements (names and numbers only) to `POST /api/requirements`;
review writes them as a `spine-parts-requirements/1` file (`spec`, `fps`,
`requirements`; never `may_fold`, scene targets or the part exception lists)
into scratch and runs the installed producer's `rig-parts check --rig <rig>
--out out --parts <handoff parts> --requirements requirements.json` on the
inspected rig spec or the latest scratch build. Each requirement gets one
line with its worst frame (click to seek); `REQUIREMENTS_*`,
`CHECK_REQUIREMENT_MET` and `CHECK_REQUIREMENT_MEASURABLE` lines are shown
verbatim. A kind the rig spec cannot offer (no mesh slot, no ik or transform
constraint, fewer than two slots) is disabled with the reason. The file rides
submitted feedback by hash and content as `context.requirements`.

The view bar is one row and keeps the layer toggles in reach in every section: **Images**
(`I`), **Mesh edges** (`M`) and **Bone points** (`B`). The keys do nothing while
a text field, textarea, select or editable text has focus, with Ctrl/Alt/Cmd
held, or on key repeat; Space stays pan and Enter stays frame entry. A disabled
toggle shows why as a tooltip, and the footer shows the same layer status. The
footer also gathers the message, player, layout, renderer, idle, remote control
and draft state; **View region** opens the numeric view. Side by side,
Reference and Rig are in the **View** menu at the right end of the view bar,
labelled with the current choice.

The side and bottom panels are resizable. The separators are thin (4px)
lines whose colour is never the scrollbar's; the grab area is wider than the
line. Drag a separator, or focus it
and use the arrow keys (Shift for larger steps) and Home/End. Escape, a
cancelled pointer or window blur during a drag returns the previous size. The
stage keeps a usable minimum. When the window is too narrow, the side columns
(left first on the compare page), and when it is too short, the Inspector, become explicit
drawers opened from buttons above the stage instead of shrinking to nothing. Responsive clamping
never overwrites the desired size, so a wider window restores it.

Settings, at the end of the left column's scrolling body, holds browser defaults: Theme, Sync cameras by
default, Repeat idle by default, and Reset layout. Defaults seed a new
inspection only. Theme is the page's only appearance control: it shows the
current inspection's appearance, and changing it applies it and saves it as the
default. A view link or source draft keeps its own appearance, camera
sync and idle choice, and restoring it neither changes the saved defaults nor
starts playback. Reset layout restores panel sizes and nothing else.

These defaults and desired panel sizes are one versioned, closed record in
browser `localStorage` (`rig-review-preferences/1`). It holds no source path,
hash, feedback, review decision or capability. The first load migrates the
earlier same-origin appearance preference. If storage is denied, unavailable
or the record is corrupt, the page uses defaults and every control keeps
working for that page; a corrupt record is refused rather than overwritten
until you change a setting. Several open tabs merge their writes per field, so
changing the theme in one tab does not undo a panel size changed in another.
Separate browser profiles keep separate preferences.

Browser storage is per origin. Managed opens share the front's one origin, so
Settings, panel sizes and drafts carry across reopens. `--direct` and foreground
serving use per-port origins and keep them separate.


## Inspect animation keys

Animate keeps its timeline in a panel of its own beside the other blocks, with Timeline, Curves and Bone tree views of the build currently on stage. Bone value tracks of `motion.animations_from` are editable: an edit is a pending op, previewed on the stage, and **Apply · Rebuild** builds it through the installed producer into scratch. Other tracks say why they are read-only, and compare mode is read-only (`ANIMATION_COMPARE_READ_ONLY`). The timeline preserves every stored bone/slot track and key time; click a key to seek, Shift-click to add or remove editable keys from a multi-key selection, or box-drag across empty lane area to select editable keys across tracks (read-only tracks are skipped and named in the status bar). Dragging any selected key retimes the whole selection by the same delta as one undo step (`ANIMATION_KEY_ORDER`, `ANIMATION_KEY_TIME_INVALID` and `ANIMATION_OPS_TOO_MANY` refuse by name without writing), and **Delete** removes the selection as one undo step (`ANIMATION_TRACK_MIN_KEYS` refuses when fewer than two keys would remain on a track). Scrub the ruler or click an empty editable lane to move the playhead. Bone selection filters its direct tracks. Tree, Parts and stage selections stay synchronized; enable **Bone points** to pick or pose a bone on stage. Selecting a bone highlights all directly attached Parts rows without inventing a selected slot. With **Bone points** on, **Pose: Rotate** and **Pose: Move** (`Alt` during drag switches for that gesture) let you drag a bone handle on stage to set its `rotate` or `translate` key at the playhead—or insert and set a key at an unkeyed playhead as one undo step—inverting the parent bone's world matrix so a translated bone tracks the cursor whether its parent is rotated or not. A bone without a matching source track (`ANIMATION_BONE_NO_TRACK`), driven by a physics/IK/transform constraint (`ANIMATION_BONE_CONSTRAINED`), or on a read-only track (`ANIMATION_TRACK_READ_ONLY`) refuses by name.

Curves show the compiled skeleton’s exact linear, stepped or cubic Bézier segments and stored handles. On an editable bone value track, **Segment** picks the outgoing key, **Mode** switches between linear, stepped and cubic Bézier, and dragging the two handles on the plot edits the segment’s `[cx1, cy1, cx2, cy2]` (`set_key_curve` / `set_key_ease` ops, coalesced on the same key and previewed live on the stage before **Apply · Rebuild**). The separately labeled **Runtime evaluation** cursor/readout uses Play’s ten-piece Float32 interpolation, which can differ from the cubic. Its local value includes setup rotation/translation and scale multiplication, in stored timeline order, before constraints and previews. Rotation is unwrapped local degrees. **Inspect time** accepts exact seconds; frame labels require the existing explicit clock. Nothing is written into the package. See [animation inspection](ANIMATION_INSPECTION.md) for the numeric validation and reproduction commands.

## Inspect a part

The Parts explorer (left column; right on the compare page) selects an actual model slot on a specific single/A/B side. All rows follow the public held snapshot's exact draw-order z, including hidden/null slots. Search matches the exact source slot names: a row is shown when its name contains the typed text, case-sensitively, with no case folding or normalization. Arrow keys/Home/End move between result buttons, Enter/Space selects, and Escape returns to search. Whole rig restores full drawing. Selecting a drawn row fits its conservative world bounds within the existing camera zoom range; Sync cameras applies the same normalized camera action to every visible pane, while independent mode changes only that selected pane. Hidden/empty geometry reports `PART_FIT_UNAVAILABLE` and keeps the camera.

Solo preserves the full held pose's resolved clips and filters only drawing. In context, the whole rig remains visible with an amber dashed conservative selection box; this box is geometry/clip bounds, not exact source-alpha coverage. Selection changes no track, skin, set, motion, source asset or review decision. The selected slot's side/mode survives source-bound links and local drafts. The Setup section shows actual posed mesh counts or region corners, page/region, current skin/set context and declared attachment candidates. **Use slot for feedback** explicitly prefills the target; selecting a row alone submits nothing.

The pinned published `@rig-c/play`1.14.0 supplies `slotIdentity()` and frame generation. The explorer atomically retains the public identity snapshot with the same-generation held frame: exact attachment key, owning skin, active set/skin, full z order and explicit hidden/no-attachment/timeline-null/set-hide reasons. Hidden/null slots keep null keys with their reported reason; declarations and texture/UV names never replace that public result. An identity-known attachment need not have a visible primitive or positive fit bounds. The current UI follows its selected slot as animation changes, updating the displayed identity to the actual held frame.

Source-bound links/drafts and explicit feedback preserve that side/slot plus exact attachment/owning skin/set/active skin/null reason. A restored explicit target is checked after restoring its animation/time/set and drawing; `PART_IDENTITY_MISMATCH` rolls back rather than silently substituting another key. Older slot-only links remain readable and resolve from the current authoritative snapshot. Runtime generation is current observation/feedback evidence, never a persistent identity. Named vertex weights and original source alpha remain unavailable in this inspection; packed pages are not original part images.

This explorer is inspection. Producer-backed optimization and candidate Apply/undo/export remain separate work; the explorer does not generate mesh, rig or motion bytes.

## Chest regions (designate, rebuild, watch)

In **Setup**, the view bar's **Chest regions** button (pressed state; hidden in Animate) opens the chest-region editor bar directly under the view bar and enables editing on the rig pane. The bar has an **R** and an **L** group, each with **X**, **Y**, **R** (core radius, 6–120) and **Band** (4–120) in crop pixels, x screen-right and y down; **Mirror R → L** copies R's y, core radius and band to L; **Download JSON**; and **Apply · Rebuild**.

On the rig pane each region is drawn as two circles: the core (full weight) and a dashed outer circle at core + band, R in one colour and L in another (two theme tokens per side), with a centre handle, a core handle on the right edge, a band handle on the top edge and a label `R (x,y) r:… b:…` under the outer circle. Dragging the centre moves the region, dragging the core edge sets r and dragging the band handle sets the band, all in crop pixels through the current camera scale. Each drag and each committed bar value is clamped live with the public example rebuild script's non-overlap rule: integer values, both cores plus 8 px must fit the centre distance minus a 2 px margin (both shrink by one factor) and the bands share what remains. A side the rule changed flashes its label and the footer says `CHEST_REGIONS_CLAMPED`. A handle drag never moves the camera; a drag anywhere else, or with Space held, still pans, and the wheel still zooms.

The bar opens on **Circles** (the R / L groups above); **Landmarks** beside it (#105) states the chest the way the producer's `meshes.<part>.contour.bust` does. Three clicks on the part place the **right apex**, the **left apex** and the **cleavage** (each pick button arms the point its click places, then the next unplaced one; a placed marker drags), with **X** / **Y** fields for each in rig pixels, an **α** slider (core ratio, the producer's default 0.22), a **Clearance** slider (rig px, default 3.8) and optional **Bone R** / **Bone L** (empty is the producer's default, `boob_r` / `boob_l`). The two circles are drawn live with the producer's own derivation (`@rig-c/parts` `deriveBustRegions`): with `d` the distance from an apex to the cleavage, `R = round(d − clearance)`, `r = round(alpha × R)` and `band = R − r`, centred on the apex, named `bust_r` / `bust_l`, spacing 14. Review pre-checks the producer's one geometric refusal on the same numbers — `CONFIG_BUST_CLEARANCE` when `clearance <= 0`, `R_r + R_l >= |apex_r − apex_l|` or a radius is not positive — draws both circles in the overlap colour, shows the producer's detail, and Apply sends nothing. Otherwise Apply · Rebuild sends `{part, bust, configHash}`: the part's entry with `contour.bust` in place of `contour.regions` (the hand-written regions are dropped; every other field as written) goes to the same `rig-parts remesh --mesh` run as Circles, and the producer derives the circles again and judges the bones (`CONFIG_NAME_RESOLVES`) and a region declared twice (`CONFIG_REGION_NAME_UNIQUE`), verbatim. The part is the contour part whose entry already states `contour.bust`, else the one the bones name, else the only contour part. A config entry that states `contour.bust` seeds an untouched Landmarks mode.

Rig pixels are the whole figure's frame, which is the crop frame the model's stage fixes (below), so a click maps through the same crop → world mapping. A part's own image is that frame less the part's `parts.json` box less the producer's 4 px pad: rig = part image + (box.x − 4, box.y − 4) (`src/chest-landmarks.ts` `partToRig` / `rigToPart`).

**Apply · Rebuild** runs the installed producer on the designated regions and reloads the result on the stage, so the loop is point → rebuild → watch → repeat → submit. Review builds no mesh itself and never runs a manifest command:

- **Producer.** `@rig-c/parts`' `rig-parts`, resolved the way `rigc review` resolves `rig-review`: `node_modules/@rig-c/parts/package.json` in the nearest directory walking up from the package, then from the directory `rig-review open` was run in; its `bin` entry is read from that manifest, never from `PATH`. The compiler is resolved walking up from `rig-parts`' own package: `@rig-c/core` first, then legacy `rig-c` only when the scoped package is absent. The selected package name and version are reported as `compiler`. Absent: `MODELING_PRODUCER_NOT_INSTALLED: … — bun add -d @rig-c/parts`; older than the first release with `remesh` (1.40.0): `MODELING_PRODUCER_TOO_OLD <found> 1.40.0`. Review never installs anything.
- **Inputs.** The producer handoff (`docs/REVIEW_PACKAGE.md`, *Producer handoff*): `open --config` (and `--parts`), else the review.json `producer` block, else `config.json`, then `rig/config.json` inside the opened folder, then `../config.json` beside an opened `out/`. The parts directory defaults to `out/` beside the config and holds `parts.json`, `parts/` and the inspected `rig/`. The editor bar shows, before any Apply, how the config was found (declared, discovered, or discovered outside the opened folder), its path and SHA-256, and the baseline. Without a handoff the bar shows `MODELING_INPUT_UNAVAILABLE: config.json — looked at …` and Apply refuses `MODELING_HANDOFF_MISSING`, naming `--config`. The request carries only `{part, regions, configHash}`; the server reads the config, replaces `meshes.<part>.contour.regions` with the designated regions (every other field as written) and runs `rig-parts remesh --rig <out>/rig --config <config> --parts <out> --part <part> --mesh mesh.json --out revision`, then `rigc build --profile rig-play --pack` with the revision's own `--page-edges` / `--pack-shape`, both with the scratch directory as working directory. A region row with equal semi-axes and no clip is sent as the config's circle, any other as the 32-sample polygon. An untouched editor starts from the config's own circle regions and contour numbers.
- **Baseline.** Once per session, when the handoff and the producer both resolve, review runs `rig-parts rig --config <config> --parts <parts> --out <state>/baseline/<key>/baseline` and compares every file it writes (rig.json, motion.json, mesh_report.json, sets.json, images/*) with the inspected rig directory: `baseline: reproduced — rig.json <hash> = inspected <hash>`, or `baseline: not reproduced — <first differing path> · <what Apply can still do here>`. The key is the package hash, the handoff record and the producer versions (no clock), so a reopen reuses the result. Ops that rebuild the whole rig refuse `EDIT_BASELINE_MISMATCH <path>` unless the baseline reproduced; `remesh` keeps its own `REMESH_BASELINE_MISMATCH`. A build the config does not reproduce — a hand repair — is not open to every Apply (#148): retune carries a **mesh** repair over but holds every image, so a repair that redrew an image refuses every physics and idle edit (`RETUNE_REQUEST_HELD: images/<part>.png`); remesh from a config entry refuses the repaired parts and re-fits the others; a mesh edit is held to the inspected mesh, not the config; and remesh, its mesh edit and retune all refuse an inspected `rig.json` (or `mesh_report.json`, `motion.json`) that is not the writer's text (`…_INPUT_WRITTEN` — re-serialise it as rig writes it, JSON with one space of indent and a closing newline, in a copy). The baseline line and `EDIT_BASELINE_MISMATCH` name which of these hold here, and a producer refusal review can explain carries `review: …` after the producer's own line (docs/REVIEW_PACKAGE.md, *Baseline reach*). Once it reproduces, `rig-parts check` runs on the baseline output in the background (into `<state>/baseline/<key>/inspected-check/`, with Apply's default `--page-edges free --pack-shape polygon`) and its summary is stored beside the baseline record as `inspected-check.json`; that is the physics readout's BEFORE for the inspected build, and a reopen reads it instead of re-running.
- **Scratch.** `<state>/rebuild/<package source hash>/<designation hash>/` under `RIG_REVIEW_STATE_DIR` (refused, by its canonical location, inside the package, its build root or the handoff root), named from the package, the config bytes, the part, the entry and both tool versions — no clock. The same designation again reuses its build and says so; a new one replaces the previous scratch build on the stage (the earlier applied records' builds are kept beside the scratch root for undo, at most eight per package). The inspected package's files are only read.
- **Watching.** The producer's lines stream into the editor bar (the latest line and a short log); a refusal shows the producer's first named line verbatim (for example `FAIL  REMESH_REQUEST_HELD: …`) and the stage is unchanged. On success the compiled scratch build (served read-only under `/rebuild/<id>/`, its model and pages hashed) replaces the drawn rig in place with the same camera, animation, time and part set; playback resumes with physics when it was running. **Reset** returns the stage to the inspected build. **Undo last Apply** (the *Applied records* list at the top of the Inspector, its depth in the label) returns the stage to the previous applied build, or to the inspected build when none is left; a predecessor whose build was evicted re-runs its recorded step and must come back byte for byte, else `UNDO_PREDECESSOR_CHANGED: <what>` (docs/REVIEW_PACKAGE.md, *Undo across Applies*). A change to the handoff config ends the session's undo stack (reopen): Undo is then refused `FRONT_INSTANCE_EXPIRED`. The Cuts and Cloth blocks mark a pending op applied only while the record on the stage holds it, so after an undo they show the predecessor's ops as applied, and none on the inspected build. The mark shows what the build on the stage carries, not every op applied so far: while a cloth build is on the stage, the Cuts block marks nothing.
- **Record.** The last applied state (`rig-review-applied/1`: part, regions, for a Landmarks Apply also `bust` — the entry as sent, with `regions` its two derived circles — config hash, entry SHA-256, producer and compiler versions, the producer's line and the scratch model's SHA-256) stays in the inspection draft, and feedback added while that build is on the stage carries it as `context.applied`. The review's `reviewedSource` still names the inspected build.
- **Config patch.** The same loop takes any config edit as data: `POST /api/rebuild {patch}` with a `rig-review-config-patch/1` document (JSON Pointer ops over the handoff config, refused `EDIT_PATCH_STALE` when made against other config bytes) rebuilds the whole rig (`rig`) or one part (`remesh`) into scratch, compiles it and runs `rig-parts check` on it; the page's `window.rigReviewEditor.applyPatch(patch)` streams, reloads and resets like Apply, and the draft and `context.applied` carry `rig-review-applied/2` (the patch, its hash, the producer's line, check's summary and the diff of every document the producer writes, per file, with the images by hash). Schema and refusals: `docs/REVIEW_PACKAGE.md`, *Config patch and Apply*.

The editor's values are the fields of Setup's **Chest regions · detail** block (R is region 1, L is region 2), which also holds what the bar does not: per region a name, a bone chosen from the loaded model's actual bones, the two semi-axes, a spacing and an optional medial clip x, plus the contour settings (tolerance, margin, spacing, max edge, stray, bridges). Setting R in the bar writes both semi-axes. A region with equal semi-axes and no clip exports as the examples' circle, `{"name", "shape": "circle", "cx", "cy", "r", "bone", "spacing", "band"}`; unequal semi-axes or a clip export as the generator's 32-sample polygon on its 1/256-pixel grid and are drawn filled, without handles.

The overlay needs the loaded model to fix the crop: its declared stage must be the crop frame with the root at its bottom centre (`x = -width/2`, `y = 0`) and the drawn root bone must sit at the world origin, so crop `(x, y)` is world `(x - width/2, height - y)`. Otherwise the editor bar and the detail block show `CHEST_REGION_MAPPING_UNAVAILABLE: <what is missing>`, nothing is drawn, and the values still edit numerically and export from a crop size you enter.

**Download JSON** (and the detail block's **Download chest-regions.json**) saves two files in the browser: `chest-regions.json`, formatted exactly as the public example files, and `chest-regions.binding.json`, which names the package source hash, the rig and motion SHA-256 values, the export time, the viewer and runtime versions and the mapping used. An export holds 1–8 regions, the set Apply accepts (#118): a detail row without a centre x is not designated, so one row exports alone; two regions keep the public examples' text byte for byte. Export refuses `CHEST_REGIONS_COUNT`, `CHEST_REGION_NAME_DUPLICATE`, `CHEST_REGION_BONE_UNKNOWN <bone>`, `CHEST_REGION_OUT_OF_CROP <name>`, `CHEST_REGION_OFF_GRID` and `CHEST_REGIONS_OVERLAP <a> <b>` (every pair is tested). Two circles overlap when their centre distance minus both cores is less than the sum of their bands; any other pair is tested through polygons. The generator refuses per mesh vertex, so this check can refuse a pair it would accept, never the reverse.

Field values stay in the inspection's local draft. They never enter the review session's feedback, nothing is written into the package, and an export is review evidence, not an approval (see `docs/DESIGN.md`).

## Mesh panel (density, regions, segments → remesh)

In **Setup**, under Chest regions · detail, the **Mesh** panel (`#mesh-panel`, #106) edits the selected part's `meshes.<part>` entry from the producer handoff's config — the entry `rig-parts remesh --mesh` takes — and rebuilds that one part. Select a mesh part in the parts list; the panel starts from the config's own entry (or the draft's pending entry for that part).

- **Modes.** The two modes whose fields the panel draws: **contour** (sliders for `tolerance`, `margin`, `spacing`, and optional `maxEdge`, `budget`, `stray`, each with a checkbox that declares or removes it; `bridges` as a checkbox) and **grid** (`grid`, optional top-level `stray`). In both: `r`, optional `exponent`, `rule` (absent / `distance` / `heat`), and the weight cut `influences.maxInfluences` and `influences.floor`. Each slider's range is review's drawing range only; the number field beside it takes any value and the producer judges it. An `auto` entry is shown with `MESH_PANEL_MODE` and no controls; an `influence` entry is not offered either, because `remesh --help` names grid, contour and auto entries and not influence (that is the producer's to document). The mode itself is not switched here.
- **Regions** (contour). **Add circle** adds a circle region (drawn like the chest editor's circles, in the mesh-region colour); **Draw polygon** arms the stage: each click places a point in rig px (whole pixels, so on the producer's 1/256 grid), **Enter** (or the button again) closes it with three or more points and **Escape** drops it. **Drag on stage** lets a polygon vertex or a circle centre be dragged; a drag never pans the camera. Each region row has its name, a bone chosen from the loaded model's bones, `spacing` and `band` (and `cx`, `cy`, `r` for a circle) and **Remove**. A `contour.bust` in the entry stays as written (the chest editor's Landmarks mode edits it).
- **Segments.** The entry's `segments` as written, each removable; **Add** appends a bone picked from the loaded model's bones. In contour mode each string segment (a chain) has a **ribs stations** field (empty: no ribs); removing a segment drops its ribs.
- **Pending entry.** The diff against the config's entry, one line per JSON Pointer (`/meshes/<part>/contour/spacing 28 → 20`). Review pre-checks the pending entry with the config loader's rules and names (`CONFIG_MESH_MODE`, `CONFIG_FIELD_PRESENT`, `CONFIG_FIELD_TYPE`, `CONFIG_REGION_NAME_UNIQUE`, `CONFIG_NAME_RESOLVES`, `CONFIG_RIBS_MODE`, `CONFIG_STRAY_MODE`) and Apply is disabled while one stands. What the outline refuses at the rig stage — a spacing whose keep radius snaps to 0 (`CONTOUR_PARAMETER`), a bridge no quad makes (`CONTOUR_BRIDGE`), a heat source (`RIG_HEAT_*`), a remesh rule (`REMESH_*`) — is sent and comes back as the producer's line.
- **Apply.** The pending entry becomes one config patch, `replace /meshes/<part>` with the whole entry and nothing else, run by `remesh --part <part>` through the patch runner (*Config patch* below): remesh into scratch, compile, check. On a build the revision replaces the drawn rig in place (same camera, animation, time and world), the **Mesh edges** layer turns on so the new triangulation is drawn, and the panel shows the part's vertex / triangle / hull counts before and after from the revision's `remesh.json`, one line comparing `remesh.json`'s after-count with the revision model's triangles for the slot and the triangles the overlay draws (`MESH_COUNTS_AGREE` / `MESH_COUNTS_DIFFER`, every figure named), and `TEXTURE_STRETCH` before (the build that was on the stage; for the inspected build its background check) and after. **Folds reading** runs the #108 folds reading of the drawn animation on the inspected build and on this revision and puts one worst-frame line per build in the status. A refusal leaves the stage and the pending entry as they were and the status line is the producer's line verbatim (for example `FAIL  REMESH_CANDIDATE_REFUSED: … CONTOUR_PARAMETER: contour mesh "<part>", spacing — is 0.003; its keep radius … snaps to 0 grid units of 1/256 px …`).
- **Reset** returns the pending entry to the config's and the stage to the inspected build.
- **Record.** The draft keeps `#mesh-pending` (`{schema:"rig-review-mesh-entry/1", part, entry}`, only while it differs from the config). A built Apply's `context.applied` is `rig-review-applied/2` with `mesh` added: the part and its counts before and after.

## Weights (setup pose, watch only)

In **Setup**, after the Mesh panel, the **Weights** block (`#weights`, #107; **Weights** in the block row) shows the selected slot's mesh weights as the compiled model document stores them. **Show weights** draws the slot's mesh at the setup pose over a veil that dims the rest of the rig: each vertex is a dot and each triangle is filled with the mean of its vertices' colours.

- **Bone weight.** Pick a bone (the slot's influencing bones first, then every other bone of the model): each vertex is coloured by that bone's stored weight on the weight ramp, 0 → 1 (`--rv-weight-0`, `--rv-weight-half`, `--rv-weight-1`); a bone that does not influence a vertex is 0 there. The legend shows the ramp and the bone.
- **Max influence.** Each vertex takes its dominant bone's colour (the largest stored weight; the first stored on a tie), from `--rv-weight-bone-1` … `-6` in the influencing bones' order; the legend names each bone with its colour.
- **Hover.** The vertex under the pointer (within 10 px) is ringed and labelled with its index, the bone and the weight drawn; the block's readout lists all of its stored influences. Values are printed as stored, never rounded or normalised.
- **Source.** The vertices and weights are the slot's attachment at the setup pose (`skins[].attachments.<slot>.<name>.vertices` of `rigc-compiled/3`: `{weighted:true, bindings}` — per vertex `{bone, x, y, weight}` — or `{weighted:false, xy}`). An unweighted mesh is its slot's bone at 1.0, named. A linked mesh reads its source mesh. A never-played player reads only the public setup identity, including any setup-slider attachment switch. Positions, triangles and hull come directly from published Play 1.14.0's `readSetupMesh`, which includes selected setup-slider deform; Review supplies no skinning formula. Its active skin selection (null for a fresh player) stays distinct from the supplying table used for stored metadata. Hidden/null identities keep their public reason and are never guessed from declarations. The stage player is not touched, so the drawing can sit apart from an animated pose on the stage.
- **Refusals.** A package without a compiled model document refuses `WEIGHTS_MODEL_UNAVAILABLE`; no slot `WEIGHTS_SELECT_SLOT`; a slot without a mesh `WEIGHTS_NO_MESH <slot>`; a malformed attachment `WEIGHTS_MODEL_INVALID`.

Nothing here edits, applies or records a weight: the block adds nothing to the draft or to feedback, and weight editing is out of scope. With **Edit mesh** on, the weights layer is not drawn.

## Bones (config anchors, check, rebuild)

In **Setup**, after Weights, the **Bones** block (`#bones-panel`, #109; **Bones** in the block row) edits where the producer config puts its bones. It reads the handoff config's `bones` as written (`GET /api/rebuild` returns them as `bones`): a single bone `{name, parent, at, tip?}` or a chain `{chain, parent, points, tip}` whose links are `<chain>0 … <chain>n` (rig-parts AUTHORING, `bones`).

- **Stage mode.** **Edit bones on stage** (`#bones-edit`, `aria-pressed`; it pauses playback and ends when Setup is left) draws every anchor on `#rig-overlay` at its config position: an origin (`at`) as a square, a chain point as a circle, a tip as a diamond, joined along the chain or from the bone to its tip. Positions are rig px, y down, mapped to the rig world through the same crop → world mapping the chest and weights views use (the model's stage). They are the config's setup positions; an animated stage pose can sit apart from them. Without that mapping no handle is drawn and the block says why.
- **Drag.** Drag a handle (within 9 px) to move it; the pointer's delta is snapped to whole rig px and added to the config's value, written with the decimals that value already has (an integer stays an integer). **Bone** (`#bones-select`) picks a bone, whose anchors can also be typed. Each move is one config patch op, `replace` at `/bones/<i>/at`, `/bones/<i>/points/<k>` or `/bones/<i>/tip`, recording the bone's name (a chain's `chain`) beside the index; the server refuses an index that no longer holds that name (`EDIT_PATCH_NAME_MISMATCH`). The pending ops are listed with their delta and a Revert each; the draft keeps them (`#bones-pending`, `{schema:"rig-review-bones-draft/1", edits}`, restored only while each anchor still holds the value it was made from).
- **Check.** `POST /api/bones-check` applies the ops to a scratch copy of the handoff config and runs the installed producer on it: `propose --from-config` prints its LINT lines, the LINT count line and one coverage line per bone (shown as printed; a LINT line blocks nothing — propose exits 1 on any, and Apply stays enabled), and `compare --left <handoff config> --right <patched>` gives each moved bone's origin (and tip) distance and the summary lines. `propose --from-config` reads the source painting: a handoff without one (declare it with `--source <png> --full <dir>`) shows `MODELING_INPUT_UNAVAILABLE: source painting — …` in place of the LINT lines, and compare still runs. Any change to the pending ops clears the last Check's lines.
- **Apply · Reset.** Apply sends the ops as one `rig` patch through the generic runner (`rig --config`, compile, `check`): a whole-rig op, so it runs only when the baseline reproduced the inspected rig (`EDIT_BASELINE_MISMATCH` otherwise). A producer or rigc refusal (`RIG_TIP_DISTINCT` for a tip dragged onto its origin, `CONFIG_NAME_RESOLVES`, rigc's `A51`, `RIG_HEAT_BONE_SOURCE`, …) is shown verbatim and leaves the stage as it was. On a build the re-weighted rig reloads in place, and the Weights block reads the revision. Reset returns to the inspected build and clears the pending ops.

Adding, removing or re-parenting bones is out of scope.

## Rig fields (regions, still row, stops, inherit, turn)

In **Setup**, after Bones, the **Rig fields** block (`#rig-fields`, #110; **Fields** in the block row) edits the producer config's small fields. `GET /api/rebuild` returns them as written in `fields` (`regions`, `motion.blink`, `stops`, `bones`, `turn`); the block's state line counts what the config states. Every edit is one config patch op at the field's own pointer, listed with a Revert; the draft keeps the pending ops (`#rig-fields-pending`, `{schema:"rig-review-rig-fields-draft/1", edits}`, restored only while each field still holds the value the edit was made from).

- **`regions.<part>`** — the bone a rigid part rides. Pick the part (selecting a region part on the stage picks it) and its bone among the bones the config declares (chain links expanded, and `root`): `replace /regions/<part>`. A meshed part is not offered.
- **`motion.blink.still.<part>`** — a lash's still row, `{row, bone}`: rows above `row` (rig px, y down) are drawn by `<part>_still` on `bone` and do not blink. The block offers the region parts on a bone the blink's `eyes` names; **Add still row** starts at the eye bone's origin row on its parent. The row is drawn across the part on the stage and dragged in whole rig px (its number and bone can also be typed): `add /motion/blink/still/<part>` (with `add /motion/blink/still {}` first when the config states no `still`), **Remove** sends `remove`. It sits in Setup, beside the part it cuts, rather than in Animate's blink controls.
- **`stops[i]`** — a stop's inward and outward bounds (degrees). Picking a stop draws its two arcs on the stage at the first stopped link's origin, around the rest aim at the touch point (`at` in `against`'s frame, as rig-c's `expandStops` aims it); dragging an arc end sets that bound in whole degrees (never below 0). The op replaces the whole entry, every other key as written, and names its `chain`: `replace /stops/<i>`. Adding a stop is out of scope.
- **Inherit** — a single bone's `inherit`, or a chain link's entry in `link_inherit`, picked among rig-c's five modes (`normal`, `onlyTranslation`, `noRotationOrReflection`, `noScale`, `noScaleOrReflection`; absent is `normal`): `add` (or `remove`) at `/bones/<i>/inherit` or `/bones/<i>/link_inherit`, naming the bone.
- **`turn`** — the pivot and a part's depth, each a slider with a number: `replace /turn/pivot`, `replace /turn/depths/<part>`. The **dial** holds the drawn build's `turn` bone at x rig px through play's `adjust` (shared with the idle preview), labelled *preview — Apply decides*: it shows the build on the stage, not the pending depths, and it is never recorded. Apply and Reset set it back to 0. `turn.deform` is out of scope.

**Apply** sends the pending ops (checked against the block's scope, `RIG_FIELDS_OP_OUT_OF_SCOPE` otherwise) as one `rig` patch through the generic runner (`rig --config`, compile, `check`) — a whole-rig op, so it runs only when the baseline reproduced the inspected rig. rig-parts has no `retune` op yet; when it has, stops and inherit can move to it. The producer's refusal (`CONFIG_STILL_OFF_THE_BLINK`, `RIG_STILL_ROW_CLEAR`, `CONFIG_BONE_INHERIT`, `CONFIG_TURN_PIVOT_BEHIND_NEAREST` and the other `CONFIG_TURN_*`, `CONFIG_NAME_RESOLVES`, rigc's `RIG_STOP_BOUNDS`, …) is shown as printed and leaves the stage as it was. On a build the revision reloads in place, the status line names the per-file diff, and the readout shows check's `BLINK_NO_HOLE` and `FEET_STAY_LEVEL` lines before (the build that was on the stage, or the inspected build's stored check) and after. **Angle range** runs the angle-range reading (#108) on the inspected and the latest scratch build with one click: the inherit bone against its parent, else a re-boned part's new bone against the bone it rode, else the part's bone against its parent. **Reset** returns to the inspected build, clears the pending ops and sets the dial to 0.

## Cuts (cut polygons, patch boxes, limb joints → rig-parts build)

In **Setup**, after Rig fields, the **Cuts** block (`#cuts-panel`, #115; **Cuts** in the block row) edits what the producer's assemble stage reads: the config's `assemble.cuts` (a plan part's layer cut by a polygon into a new part), `assemble.patches` (a part cut from the painting by a box) and `limbs` (a limb cut at its joints). `GET /api/rebuild` returns them as written in `cuts.config` (`assemble.plan`, `assemble.cuts`, `assemble.patches`, `limbs`) with `cuts.build`, the refusal that stops an Apply here (null when the handoff declares the painting and the runs). Everything is in rig px of the setup pose, the space of `parts.json`, mapped to the stage through the same crop → world mapping the chest, mesh and bones views use.

- **Stage mode.** **Edit cuts on stage** (`#cuts-edit`) draws each cut polygon and patch box with a handle on every vertex and corner, each limb joint (the lower segment's bone origin) as a diamond, and a declared `range` as an arc from the joint (min to max degrees from the lower bone's rest direction, counter-clockwise on screen, rigc's sense). Drag a handle (within 9 px); the pointer's delta snaps to whole rig px. **Entry** (`#cuts-select`) picks a cut, a patch or a joint, whose numbers can also be typed.
- **Ops.** A vertex is `replace /assemble/cuts/<i>/polygon/<k>` naming the cut by its `into`; a box is `replace /assemble/patches/<i>/box` naming the patch; a range is `add`, `replace` or `remove` at `/limbs/<limb>/segments/<k>/range` naming the segment's `part`; a joint is a bones op (`/bones/<i>/at` or `/bones/<i>/points/<k>`), since the joint is its bone's origin. The server checks the recorded name against the index (`EDIT_PATCH_NAME_MISMATCH`). **Place cut** / **Place patch** add a new part by clicking its polygon's points or its box's two corners: `add /assemble/cuts/-` (`{from, into, polygon, draw, overlap}`) or `add /assemble/patches/-` (`{name, box, alpha, draw}`), and `add /regions/<name>` with the bone typed beside it. Review refuses before sending only what is not the loader's type (`CUTS_VALUE_INVALID` for a negative or non-integer point, `CUTS_POLYGON_SHORT`); everything else is the producer's. The draft keeps the pending ops (`#cuts-pending`).
- **Apply · Reset.** Apply sends the ops as one `rig` patch. The server runs it as `rig-parts build` (*Config patch and Apply*, Routing) from the declared painting and runs into scratch — a whole-rig op behind the reproduced baseline — and the scratch build reloads in place. The producer's refusal is shown as printed (`ASSEMBLE_CUT_INSIDE`, `ASSEMBLE_CUT_OVERLAP`, `ASSEMBLE_CUT_PIXELS`, `ASSEMBLE_UNDER_SIZE`, `ASSEMBLE_UNDER_DRAW`, `CONFIG_LIMB_RANGE`, `CONFIG_LIMB_BONE`, `CONFIG_PART_UNIQUE`, …), and a check bar that is not met (`SEAM_OVER_RANGE`, `LIMB_ONE_BONE`, `CHECK_SEAM_WITHIN_BAR`) keeps the build with check's FAIL line. The readout shows the `cut:` / `limb cut:` / `limb cap:` lines, the recomposite figures before and after with the scratch build's `recomposite_error_rig.png`, the setup-pose `seam` and `seam pair` lines, which parts changed and the build's wall clock, which the applied record keeps. Reset returns to the inspected build and clears the pending ops.

Review paints no image: a new cut names no `under`, and a patch may only keep, move or drop an `under` or `cap` the config already names (`EDIT_PATCH_PATH_HELD`). Removing a cut or a patch is out of scope.

## Mesh edit (typed delta, preview only)

In **Setup**, the view bar's **Edit mesh** button (pressed state; hidden in Animate) edits the selected slot's actual mesh attachment **in setup space**: the attachment's entry in the compiled model document (`skeleton.model.json`), its full-double setup world coordinates, triangles and hull from published Play 1.14.0's `readSetupMesh(assets, {slot, attachment, skin})`, shared with Weights. A never-played player reads only the public setup identity, including any setup-slider attachment switch; the named geometry read owns setup-slider deform. Its active skin selection (null for a fresh player) is distinct from the supplying table returned as `skin`. Hidden/null identities remain unavailable with the public reason; Review never guesses a mesh from declarations. A package without the model document (a Spine export alone, or the bundled demo) refuses `MESH_EDIT_MODEL_UNAVAILABLE` and the editor does not open. With **Whole rig** selected it refuses `MESH_EDIT_SELECT_SLOT`; a slot whose setup attachment is not a mesh refuses `MESH_EDIT_NO_MESH <slot>`, and so does a linked mesh (edit its source mesh). Entering pauses playback (the stage keeps the pose it held, under the veil; the mesh is drawn at the setup pose with the stage's own camera), turns the chest-region editor off and opens the mesh editor bar under the view bar. The rig pane dims except the slot's own triangles; the mesh is drawn at full opacity with every vertex as a handle, hull edges, interior triangulation edges and added constraint edges each in their own theme token.

The bar has four sub-modes, one pressed at a time, with single keys that avoid the layer keys `I` / `M` / `B`:

| Key | Sub-mode | Pointer |
| --- | --- | --- |
| `V` | Modify | drag a vertex, or an edge to move both ends; Shift-click adds to the selection; drag empty space to box-select; arrow keys nudge the selection 1 crop px (Shift 10) |
| `C` | Create | click empty space to add a vertex; click an edge to split it at the click point |
| `X` | Delete | click a vertex to remove it and its edges (a vertex that ends a constraint edge is refused until that edge is removed, `MESH_EDIT_CONSTRAINT_END`); click an added constraint edge to remove it (hull edges are refused, `MESH_EDIT_HULL_EDGE`; triangulation edges belong to the producer's retriangulation, `MESH_EDIT_TRIANGULATION_EDGE`) |
| `E` | Edges | click vertex A then vertex B to add a constraint edge; click a constraint edge to remove it; a hull edge is refused and an existing edge records nothing |

Hit-testing is in screen pixels through the current camera: a vertex within 6 px (8 on touch) wins over an edge within 4 px. In a sub-mode a press never pans; Space-drag still pans and the wheel still zooms. Escape leaves the sub-mode, a second Escape leaves mesh edit. **Undo** / **Redo** (Cmd/Ctrl-Z, Shift-Cmd/Ctrl-Z) step one action at a time — an edge or multi-selection drag is one action of several `move` ops. **Reset** drops the attachment's whole delta after a confirmation.

Everything is a typed delta over the loaded mesh, in setup-pose crop pixels of the rig canvas (x right, y down, the chest regions' crop mapping): `{schema:"rig-review-mesh-edit/1", slot, skin, attachment, source:{vertexCount, triangleCount, hullLength, hash}, units, basis:"setup", preview, ops}` with ordered ops `move {v, from, to}`, `add {at, onEdge?}`, `remove {v}`, `edge {a, b}` and `unedge {a, b}`. Source vertex ids are the attachment's indices; an added vertex takes the next id; a removed id is never reused. `hullLength` is the model's `hull` (the first `hull` vertices, in order, are the hull) and `hash` is the SHA-256 of `JSON.stringify` of the attachment's entry in the hash-verified model document. Source positions are not rounded (a `move`'s `from` is the vertex's exact setup position; `to` and `add.at` are rounded to 0.01 px). This is the input `rig-parts remesh --delta` reads as it is (see [docs/REVIEW_PACKAGE.md](REVIEW_PACKAGE.md#mesh-edit-export)); the former last-drawn-pose basis is gone. The overlay previews moved, added and removed vertices and the constraint edges over the original triangulation; nothing is retriangulated in the browser (the status line says *preview only — the producer retriangulates*).

**Download JSON** saves `mesh-edit.json` and `mesh-edit.binding.json` (package source hash, rig and motion SHA-256, the attachment and its hash, export time, viewer and runtime versions and the mapping). **Apply · Rebuild** (#135) sends the delta to the installed producer as `POST /api/rebuild {part, delta, configHash}`: the server writes it as `mesh-edit.json` (the download's bytes) into the scratch directory and runs `rig-parts remesh --rig <handoff rig> --config <handoff config> --parts <handoff parts> --part <part> --delta mesh-edit.json --out rig`, then the shared tail (per-file diff, compile with remesh.json's pack flags, hash). The producer must read `--delta` (`@rig-c/parts` 1.43.0 or later, read from its own `package.json`), else `MODELING_PRODUCER_TOO_OLD <found> 1.43.0`. The delta's schema, basis, source counts and `source.hash` and every op are the producer's judgment: its `REMESH_DELTA_*` / `REMESH_*` line comes back verbatim and the stage keeps its model. A built revision loads in place and the editor re-reads that revision's setup mesh; `context.applied` becomes `rig-review-applied/3` (the delta by content, `deltaSha256` of its bytes, the producer's line, `op: "remesh"`, the per-file diff and the part's counts). While the revision is on the stage, Reset returns to the inspected build and the draft's delta is restored over it. A delta drawn over the revision's mesh is refused by the producer (`REMESH_DELTA_SOURCE`): its input is always the handoff rig. The delta rides in the inspection's local draft bound to the attachment hash (at most 300 ops per attachment); it never enters the review session and nothing is written into the package.

For inspection automation, `window.rigReviewEditor.meshEdit()` returns the open editor's source (setup-pose crop px per vertex, unrounded), its ops and each drawn vertex as page client pixels, or `null` when the editor is closed; it reads only.

## Retarget (map, flags → rig-pose, watch)

In **Animate**, the **Retarget** block (#114) puts a pose sequence the package declares onto the inspected rig through the installed `@rig-c/pose`. The sequence is a `rig-pose-sequence/1` pose reference the package declares (a `references` entry of type `pose` in `review.json`, or a `*pose*.json` in an opened folder); review takes no other file. The block's controls:

- **Map** — a `rig-pose-map/1` editor. Start from **Body-18 chains** (trunk, both arms, both legs, no bone picked) or load a map file (read in the page and sent by content, never by path). Per chain: include it or leave it out, pick the rig bone that carries each segment (a name the rig lacks stays listed as *not in the rig*, so Apply shows the producer's own refusal), and its `bend`. The translated bone and the two rig points of `translate.scale` are picked the same way. **Map JSON** shows the whole document; aims, ranges, alternates and the rest are edited there and taken with **Use this JSON**. A bone not yet picked is refused before anything is sent (`RETARGET_MAP_INCOMPLETE`).
- **Clean** — clean first (default; a sequence that already carries clean's record starts with it off), `--loop`, `--legs`, `--rest`, the stillness hold and `--hips-inferred`. With clean off the sequence goes to retarget as the package holds it, and an uncleaned one is refused by the producer (`POSE_NOT_CLEANED`).
- **Retarget** — the new animation's name (`--animation`), `--flip`, `--short`, `--min-score`, `--bends refuse|clamp`, `--bend-tolerance`, `--leg-scale min,max`, `--plant-feet`, `--stance`, `--raised-by-head`, `--carry-idle`, and the person when the sequence holds more than one.

**Apply · Retarget** sends `POST /api/rebuild {retarget: {sequence, map, flags, configHash}}` — a reference id, the map by content and typed flags; the server maps the flags to argv. Into a scratch directory under the review state directory it writes the sequence (`pose.json`) and the map (`map.json`), runs `rig-pose clean --pose pose.json --out pose.clean.json …` and `rig-pose retarget --rig <handoff rig> --map map.json --sequence pose.clean.json --out motion.json …`, copies the handoff rig's files beside the new `motion.json` as `rig/`, and finishes with the shared tail: the per-file diff against the inspected rig and `rigc build` with Apply's default pack flags, using the `rigc` installed beside `@rig-c/pose`. The package's `motion.json` is never written; review writes no keys. Every `FAIL` line of a refusal is shown verbatim — `POSE_NOT_CLEANED`, `POSE_BEND_ONE_WAY`, `RAISED_HEAD`, `MOTION_NAME_FREE`, `MAP_RESOLVES` / `MAP_BONE_EXISTS` — and the stage keeps its model. A built job loads in place, the new animation is chosen, the sequence is shown as the reference beside the rig, and the run's FEET, STANCE, FLIP, SHORT, END-ON, LEG-SCALE and REACH lines are listed; each line seeks to the first frame it names, at the motion's own key time for that frame (the run's report `frameTimes`). While that build is on the stage, its report `frameTimes` are the new animation's clock: the transport counter reads `F<n> / <last>` (`frameTimes · … · this build's report`) instead of `rate unknown`, and the rig pane's header names the animation, frame and time the drawn pose is at (`Generated rig · walk · F14 · 0.583 s`) — the same clock a seek sets. Reset or another rebuild drops that clock. `context.applied` becomes `rig-review-applied/4`, with the `rig-review-retarget/1` record (sequence by reference, path and hash; map by content and hash; flags and their argv), the producer's line, what the scratch motion holds against the inspected rig's, the per-file diff and the listed lines. **Reset** returns to the inspected build. `rig-pose compare --sheet` is not run: it needs a detector pass over the render, which review does not run.

To reproduce an Apply outside review, run the same producer with the record's flags in an empty directory holding the sequence as `pose.json` and the record's map as `map.json`: `rig-pose clean --pose pose.json --out pose.clean.json <op.clean…>` then `rig-pose retarget --rig <handoff rig> --map map.json --sequence pose.clean.json --out motion.json <op.args…>`. Its `motion.json` is byte-equal to the scratch build's `rig/motion.json`.


## Turn pad

A model with supported turn sliders gets a **Turn pad** above the stage, separately
from the Rig fields producer preview. The loaded model must declare both the bone
and exactly one local, non-looping slider: `yaw_dial`, `pitch_dial`,
`body_yaw_dial`, or the bone a compiled `body_turn` slider names. The latter is how
the producer carries a custom `turn.body.slider`; no producer config or character
name is consulted. A bare bone name is insufficient. The label's tooltip names
the actual slider, bone, channel and animation. Unsupported or ambiguous bindings
are not offered. A model without these bindings gets no pad or turn log.

Move the pointer across the rig viewport: its first/last CSS pixel spans the
slider's actual range, with zero at the centre (each half maps to its own endpoint).
Head yaw and body follow horizontal position; pitch increases upward. The range is
the inverse of `time = to + (value − from) × scale` over the slider animation's
actual duration, including negative scales; only finite ranges containing zero
are supported. No degrees or range are inferred from the art or the bone name.

**Applied** is the eased value sent through published Play's `player.adjust` /
`BoneAdjust`, before constraints and physics; **target** is the pointer's value.
The number field edits the target, applies that exact value immediately and turns
**Hold** on. Hold freezes the current applied values and cancels pending travel;
**Reset 0** applies zero and holds it. Neither operation changes inspection time.
**Smoothing** displays the official head-turn demo's critically damped spring
frequency, `ω₀ = 20 s⁻¹`; its number accepts 1…100, and switching it off applies
pointer values immediately. The spring runs in normalized pointer space before
mapping into each range. A held or restored value is not spring-interpolated.
Camera drags, modal dialogs and rebuilds do not steer the pad.

In **compare**, only axes declared on both loaded models are offered. Their ranges
are intersected and that common range is displayed. Both panes receive the same
numeric value, even when their own ranges or body-dial bone names differ; no
per-pane normalization or clamp changes the requested angle. An axis absent on
one side is omitted. If no supported common axis remains, no pad is shown.

The exact applied values, Hold and smoothing setting are kept in the source-bound
view link/local draft. Reload restores them paused and validates the current
model's supported axes and bounds. Feedback captures those applied values in its
separately validated `context.turn`; submitted feedback retains the immutable
package/model/motion identity. It does not record pending pointer travel, author
keys, write `motion.json` or change source files. The Rig fields `turn` x preview
remains independent, temporary and unrecorded.

## Stage comments

The visible **Comment · C** stage button is present on the rig, compare A/B and reference video. Toggle it, drag a rectangle (or click a point), type, and press Enter. Playback pauses, turn is held, and the inline composer receives focus; Escape cancels. Text is the only required input. An active Edit Mesh keeps its Create shortcut C; leave the editor before using Comment. With Comment off, selection, turn and camera gestures keep their normal behavior.

**Comments** lists numbered marks with their placement mode. Setup and Animate marks appear only in that mode; the compare page always records Compare. Returning to a mode shows its marks again at their captured pose. A row restores its captured mode before its exact frame/time, camera and turn. Placement mode is captured when the gesture begins, before asynchronous crop/save; changing mode cancels the pending drag or composer and never rebinds it. Edit or delete an unsent comment here; submitted marks are read-only. Pins and rectangles use world coordinates (reference pixels, Y down, for the video), follow zoom and pan, and appear only at the captured frame/time and dial state. Reference letterboxing is included in its camera mapping. The list is also a way back to a mark hidden in another mode or pose. JSON exports index every canonical feedback comment by mode; Markdown places the full comments under their mode headings. Missing mode refuses `COMMENT_MODE_MISSING`, unknown mode refuses `COMMENT_MODE_UNKNOWN`, and a mode incompatible with the saved page/inspector refuses `COMMENT_MODE_MISMATCH`; no missing-mode guess or migration is made. Ordinary feedback and legacy text context are unchanged.

Each mark is an ordinary feedback row, category defect, with its available single-frame interval, or explicit time-only evidence when a single review has no producer frame, and topmost intersecting drawn slot (or the rig for empty regions and reference views). Picking intersects posed triangles with the held clipping polygon and uses nearest-first draw order; it is geometric coverage, not texture alpha picking. The crop is a bounded, resampled PNG of the current pane background and shown layers, with the mark burned in; it is an agent reading aid, not a pixel-identical measurement. It copies displayed rig rasters when they match the held public frame, plus the actual overlay canvases; a whole live canvas is used directly when available. The fallback uses the held public frame and current backend, and Images off omits its image tier. Video crops retain the actual displayed content and letterbox. Compare can use its existing indexed decoded reference when producer timing is missing. A clockless single rig or reference view saves a `rig-review-time-only/1` seconds basis and an explicit frame-unavailable reason. The mark frame, row frameStart/frameEnd, context.frame and inclusive interval are null; the list and exports state the time and why the frame is unavailable. No numeric sentinel, inferred FPS or callback-count frame is used. A frame strip refuses this row by name (`COMMENT_CLOCK_UNAVAILABLE`); the comment itself remains savable, editable before submission and restorable at its exact saved seconds/camera/turn.

Comment is unavailable while an unapplied authoring preview or designation is on stage. The disabled control and adjacent reason name `COMMENT_UNAPPLIED_PREVIEW` and the active tool (Idle tracks, Rig fields dial/handles, Physics live overrides, a loaded density-strip candidate, or Chest/Bones/Cuts/Cloth/Mesh editing geometry/handles). Pending form values with no stage effect remain allowed. Stop that preview explicitly; Comment never clears or applies it. An applied scratch build retains its refusal (`COMMENT_APPLIED_BUILD_UNSUPPORTED`), and a model replacement names `COMMENT_SOURCE_BUSY`. Enable-before-preview and asynchronous pause/crop transitions are rechecked before capture/save. Standalone Turn pad, world/reference inspection and source mesh/bone/selection/weights inspection stay available. Retarget has no unapplied live pose path; Apply is a rebuild.

A reference-basis comment cannot become a producer-frame strip: CLI and browser batch export refuse `COMMENT_REFERENCE_STRIP_UNAVAILABLE` for reference-frame comments on any viewport, including compare A/B fallback. No frame-rate/time mapping is attempted. Ordinary manual and producer-frame intervals still export; time-only comments retain `COMMENT_CLOCK_UNAVAILABLE`. Comments and their JSON/issue reports remain savable/readable with their original reference timing.
