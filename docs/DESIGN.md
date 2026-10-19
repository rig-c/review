# Human rig inspection and modeling touch-up direction

## Product boundary

The delivery unit is an existing output folder or an optional curated review package handed from an agent to a person. This reusable app owns inspection, reference comparison, annotations and feedback export. Upstream compiler, splitter and runtime remain their respective tools. The existing producing agent needs no change to open its output here.

The person uses one inspection workspace with **Setup**, **Animate** and **Feedback** sections (the compare page keeps **View**, **Rig**, **Playback** and **Feedback**). Setup covers setup geometry, source art, pivot/joint placement, meshes, weights, draw order and angle coverage; Animate covers frame intervals, reference video/poses, contact/deformation and audio inspection. Motion is strictly **view, annotate and export**: time/angle controls navigate inspection. This app does not author animation keys, retime motion or write `motion.json`. Future modeling touch-up remains in scope as a design goal; it is not implemented by this starter.

## Implemented foundation

The CLI opens `review.json` or an existing output directory. The directory adapter builds a manifest in memory from `skeleton.*`, `motion.json`, `report.json`, source video, contact strips and canonical pose-sequence evidence. It never changes delivered output. A compiled model uses the published play runtime. Raw Spine output is evidence with playback explicitly unavailable. Source-only data never becomes a fabricated playback success.

Inspection supports local references, checkpoint context, runtime playback when a real compatible model exists, available angle/audio facilities and explicit review state. The canonical `rig-pose-sequence/1` format documented by `@rig-c/pose` preserves frame times, person IDs, joint states/coordinates/confidence and optional camera metadata. The demo pose is an authored synthetic transport example, not extracted from footage.

Feedback has an inclusive integer frame interval, target `{kind: bone|slot|rig, name}`, category `defect|quality`, and one-line summary. Optional context records the checkpoint, time, reference/person and camera/axis state. The person can export data and issue-ready Markdown; this app neither posts issues automatically nor writes proposed motion keys. Notes must be useful to the producing agent without interpreting a free-form key-edit JSON blob.

Identity, revision and content hash bind every decision. A submission also records separate exact rig/motion hashes and paths, packageRevision, viewerVersion and installed runtimeVersion; absent source stays null. The producing agent can retrieve the saved JSON with the read-only feedback CLI after the UI closes. Opening never means reviewed. The person explicitly approves, requests changes or returns to pending, independently of checkpoint outcomes. Changed inputs do not inherit prior approval. Feedback writes remain outside source, are bounded and atomic, and require the app's exact Origin.

## Modeling touch-up direction

Future modeling interactions should select actual parts, bones, pivots and mesh vertices in the posed view, inspect weights and ordering, and adjust bounded setup geometry with before/after comparison. Angle inspection needs declared axes and measured coverage; one scalar animation dial does not establish compound view synthesis.

The modeling requirements to preserve are local mesh-density adjustment, edge/curvature refinement, direct source-image comparison, a chest-region center/radius control, an integrated parts viewer with preset switching, and a face/body angle deformation sweep. These need actual geometry/source evidence and explicit acceptance criteria; they are not implemented by illustrative controls or a successful parser load.

Any future modeling edit needs provenance, undo/redo, explicit units and an exportable patch identifying the original hash and authoritative authoring target. A named adapter must apply it and rerun the owning tool's validation. Compiled-model rewrites are insufficient when source files are authoritative; conflicts must be named. This is a future modeling requirement, not permission to build a motion authoring tool.

## Acceptance progression

1. Delivery and feedback: one command opens unchanged output; declared assets load; explicit frame/target/category feedback saves and exports; changed source invalidates approval.
2. Runtime inspection: a real gated artifact plays and seeks through the public runtime, survives reference and Inspector section changes and names missing dependencies. Source-only fixtures cannot close this item.
3. Modeling touch-up: a bounded real geometry edit round-trips into authoritative source, reruns its gate and presents measured before/after evidence with undo/conflict controls.

## Screen prototype

[design-prototype.html](design-prototype.html) preserves the interactive screen concept. It is **illustrative**, with sample controls/data, separate from the implemented app. Its older motion key/curve editing concept is superseded by the current view/annotate/export boundary. It does not demonstrate completed mesh, motion, angle or audio editing.

## Workspace layout

The single review page is one inspection workspace: a left column, the stage, the Inspector under the stage and one status footer. There is no right panel.

- **Left column.** The Parts explorer fills it. Checkpoints, the current checkpoint title and the reference select fold into a compact strip above the part list; the strip opens when the package supplies checkpoints or references and stays folded for a plain output folder. Browser Settings sit at the bottom.
- **View bar.** Pane choice, the persistent image / mesh edges / bone points layer toggles (keys `I`, `M`, `B`), camera sync and zoom, then appearance, repeat idle and Copy view link at the right end. The toggles stay native checkboxes, so their checked state is the pressed state, the draft input and the `layers` control value. A disabled toggle names the footer's layer reason as its tooltip. Turning images off leaves the mesh/bone overlay alone.
- **Inspector.** Three sections: **Setup** (selected part, part presets, modeling-review proposals, angle panel), **Animate** (transport, frame navigation, motion-review proposals, sound cues, report events) and **Feedback** (review status, reviewed source with the read-only source-file list, selected checkpoint, structured feedback, frame-strip export). Their element ids and saved section names (`rig`, `playback`, `feedback`) are unchanged; a saved `view` section from older links restores without selecting a section.
- **Footer.** Message (truncated, full text as tooltip) on the left; player, effective layout, renderer, layers, idle, remote control and draft state in the middle; the numeric view region (behind **View region**) and the source hash on the right.

The compare page keeps its own markup and stylesheet: sources left, Parts explorer right and its four Inspector sections.

## Inspection strips

An inclusive annotation interval can also become a derived frame strip. The single view selects one declared source video; compare retains its explicit shared video and chooses a producer clock basis for each interval. A batch preserves separate feedback intervals and side provenance. Source rows run down the sheet and requested producer frames run across it. A vertical batch repeats this grid rather than merging overlapping annotations.

Exact report `frameTimes` selects the requested seconds. Actual video decoding selects the nearest presented PTS (ties earlier), which drives all rig rows through the same published player/poser and fixed seek step as inspection. Requested frames, decoded PTS and each side's independently known frame remain distinct data. Missing clocks do not become a guessed rate or an empty rendered cell: PNG names the regeneration requirement and JSON can preserve an unmapped selection.

The export uses dedicated real canvas players and leaves the live playhead/session alone. PNG pixels, full source identity/footer and JSON are derived output outside the input packages. Exporting never approves a review or authors motion. Browser download controls share the bounded backend plan; a CLI can render and write new external files without providing a filesystem endpoint to the browser. Real CLI canvas/video tests do not establish browser WebGL or interactive presentation parity.


## Implemented slot inspection and public identity snapshots

The Parts explorer (the review page's left column; the compare page's right one) provides source-hash-bound slot selection, held-pose clipped Solo, Whole/context, conservative bounds fit, a diagnostic selection box, actual mesh/region counts and reproducible selection context. This is inspection rather than geometry editing. All rows use the public held identity snapshot's exact z order, including hidden/null slots. Current source-bound links/drafts and control observations retain side/slot/mode.

Published Play1.12.0 supplies a frozen `slotIdentity()` snapshot coherent with `posedFrame().generation`. Review retains copied frame/identity together only after equal-generation and source-slot/order checks, uses the player's default public filter, and never seeks/reposes/changes physics merely to read identity. Exact owning skin/key, active set/skin and null reasons come from that snapshot, not a unique-declaration or texture match. A resolved identity can remain known without visible geometry or fit bounds. Clip declarations do not invent keys when the API reports no drawable attachment.

Live selection follows a slot. A source-bound bookmark captures its exact identity tuple at that pose; restore validates it after applying time/animation/set and drawing, with transactional rollback on a named mismatch. Old slot-only bookmarks resolve through current public identity. Generation belongs to current readback/feedback, not a stable source target. Named weights and original part alpha remain unavailable without an exact original-source mapping. A conservative bounds box and counts are not source-faithfulness or physics validation.

A future optimization operation sends explicit source-bound selection/bounds to the owning producer. That producer returns a new package revision/hash and provenance including producer version/request identity; Review never regenerates rig, motion or mesh bytes. Candidate Apply/undo/export requires its own implemented contract and acceptance, rather than being inferred from the explorer.

## Workspace geometry and browser preferences

Side and bottom panels have pointer and keyboard separators with separator semantics: orientation, the controlled panel, an accessible name and the actual reachable minimum/maximum/current pixels. Arrow keys act only when the separator itself has focus, so text-entry arrows are never intercepted. A drag holds pointer capture; cancel, lost capture, blur, Escape and disposal restore the previous desired size and release it.

The allocator measures the layout rectangle minus stage chrome and keeps a 240×180 CSS-pixel stage minimum. It shrinks side panels proportionally toward their own minima; when the width still cannot hold them it turns the left, then the right column, and when the height cannot hold it the Inspector, into a native modal drawer opened from a trigger outside it. Effective sizes are computed from desired sizes and never written back; a separator inverts the allocator so a clamped pixel value is not saved as the desktop desire.

Browser defaults live in one closed, versioned record: theme, default camera sync, default idle repeat and the three desired panel sizes. The saved `rightWidth` is the Parts explorer's width wherever the page shows it, so the review page's left parts column keeps the width chosen before the move; `leftWidth` is the compare page's sources column. Each field carries a logical stamp, so stale whole-record writes from other tabs converge per field without wall-clock ordering; an equal-stamp disagreement quarantines only that field until an explicit edit repairs it. Denied, unavailable or corrupt storage falls back to in-page defaults. The legacy same-origin appearance key migrates once, only when no new record exists. Reset layout changes geometry only.

Content state stays source-bound. Each Inspector section's x/y scroll offset is captured before its panel hides and restored after it shows, after two frames of layout, and again when its content extent changes. Restoring clamps to the current extent without replacing the remembered offset, and intentional user scrolling supersedes a pending restore. Offsets are kept in the source draft's UI state, never in the global record or a copied view link.

Browser storage is origin-scoped. Managed opens (the default) share one loopback front origin that routes `/instances/<key>/…` to each worker, so Settings, sizes and drafts carry across reopens; `--direct` keeps per-port origins. Because one origin cannot isolate its scripts, writes require a per-instance capability handed off only in the printed `#cap=` fragment and checked by both the front and the worker; a fragment-less copied link is read-only. Draft scopes carry the source hash, so revisions of one package never clobber each other's drafts.

## Comparison eligibility

A layout is offered only for inputs that actually loaded and rendered. One pure decision (`src/comparison-eligibility.ts`) takes load outcomes, never declared paths: the rig counts after its first successful draw, an image after `decode()`, a pose after it parses, and a video after `seeked` at the held time with a decoded frame. A new video stays pending until then; a held time outside its duration is refused as `REFERENCE_OUT_OF_DOMAIN`, never clamped.

Single review keeps the requested layout in the source-bound draft and shows it when usable; otherwise the most useful loaded single pane is shown. Unavailable layout buttons stay visible, disabled, with the named reason as their description, and no placeholder pane stands in for a missing input. Two-build comparison keeps its identity and domain checks: a failed side leaves the survivor as a static single pane with the failed side named, feedback needs the settled pair, and a real zero-duration domain allows static inspection without playback. Modeling-candidate comparison is reported as unavailable (no producer handoff); no candidate UI exists. Remote observation reports the requested and effective layouts and each reason.
