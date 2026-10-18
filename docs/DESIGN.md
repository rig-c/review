# Human rig inspection and modeling touch-up direction

## Product boundary

The delivery unit is an existing output folder or an optional curated review package handed from an agent to a person. This reusable app owns inspection, reference comparison, annotations and feedback export. Upstream compiler, splitter and runtime remain their respective tools. The existing producing agent needs no change to open its output here.

The person needs two workspaces: **modeling** for setup geometry, source art, pivot/joint placement, meshes, weights, draw order and angle coverage; **motion** for playback, frame intervals, reference video/poses, contact/deformation and audio inspection. Motion is strictly **view, annotate and export**: time/angle controls navigate inspection. This app does not author animation keys, retime motion or write `motion.json`. Future modeling touch-up remains in scope as a design goal; it is not implemented by this starter.

## Implemented foundation

The CLI opens `review.json` or an existing output directory. The directory adapter builds a manifest in memory from `skeleton.*`, `motion.json`, `report.json`, source video, contact strips and canonical pose-sequence evidence. It never changes delivered output. A compiled model uses the published play runtime. Raw Spine output is evidence with playback explicitly unavailable. Source-only data never becomes a fabricated playback success.

Inspection supports local references, checkpoint context, runtime playback when a real compatible model exists, available angle/audio facilities and explicit review state. Nova's canonical `rig-pose-sequence/1` preserves frame times, person IDs, joint states/coordinates/confidence and optional camera metadata. The demo pose is an authored synthetic transport example, not a Nova extraction.

Feedback has an inclusive integer frame interval, target `{kind: bone|slot|rig, name}`, category `defect|quality`, and one-line summary. Optional context records the checkpoint, time, reference/person and camera/axis state. The person can export data and issue-ready Markdown; this app neither posts issues automatically nor writes proposed motion keys. Notes must be useful to the producing agent without interpreting a free-form key-edit JSON blob.

Identity, revision and content hash bind every decision. A submission also records separate exact rig/motion hashes and paths, packageRevision, viewerVersion and installed runtimeVersion; absent source stays null. The producing agent can retrieve the saved JSON with the read-only feedback CLI after the UI closes. Opening never means reviewed. The person explicitly approves, requests changes or returns to pending, independently of checkpoint outcomes. Changed inputs do not inherit prior approval. Feedback writes remain outside source, are bounded and atomic, and require the app's exact Origin.

## Modeling touch-up direction

Future modeling interactions should select actual parts, bones, pivots and mesh vertices in the posed view, inspect weights and ordering, and adjust bounded setup geometry with before/after comparison. Angle inspection needs declared axes and measured coverage; one scalar animation dial does not establish compound view synthesis.

The modeling requirements to preserve are local mesh-density adjustment, edge/curvature refinement, direct source-image comparison, a chest-region center/radius control, an integrated parts viewer with preset switching, and a face/body angle deformation sweep. These need actual geometry/source evidence and explicit acceptance criteria; they are not implemented by illustrative controls or a successful parser load.

Any future modeling edit needs provenance, undo/redo, explicit units and an exportable patch identifying the original hash and authoritative authoring target. A named adapter must apply it and rerun the owning tool's validation. Compiled-model rewrites are insufficient when source files are authoritative; conflicts must be named. This is a future modeling requirement, not permission to build a motion authoring tool.

## Acceptance progression

1. Delivery and feedback: one command opens unchanged output; declared assets load; explicit frame/target/category feedback saves and exports; changed source invalidates approval.
2. Runtime inspection: a real gated artifact plays and seeks through the public runtime, survives reference/workspace changes and names missing dependencies. Source-only fixtures cannot close this item.
3. Modeling touch-up: a bounded real geometry edit round-trips into authoritative source, reruns its gate and presents measured before/after evidence with undo/conflict controls.

## Screen prototype

[design-prototype.html](design-prototype.html) preserves the interactive screen concept. It is **illustrative**, with sample controls/data, separate from the implemented app. Its older motion key/curve editing concept is superseded by the current view/annotate/export boundary. It does not demonstrate completed mesh, motion, angle or audio editing.

## Inspection strips

An inclusive annotation interval can also become a derived frame strip. The single view selects one declared source video; compare retains its explicit shared video and chooses a producer clock basis for each interval. A batch preserves separate feedback intervals and side provenance. Source rows run down the sheet and requested producer frames run across it. A vertical batch repeats this grid rather than merging overlapping annotations.

Exact report `frameTimes` selects the requested seconds. Actual video decoding selects the nearest presented PTS (ties earlier), which drives all rig rows through the same published player/poser and fixed seek step as inspection. Requested frames, decoded PTS and each side's independently known frame remain distinct data. Missing clocks do not become a guessed rate or an empty rendered cell: PNG names the regeneration requirement and JSON can preserve an unmapped selection.

The export uses dedicated real canvas players and leaves the live playhead/session alone. PNG pixels, full source identity/footer and JSON are derived output outside the input packages. Exporting never approves a review or authors motion. Browser download controls share the bounded backend plan; a CLI can render and write new external files without providing a filesystem endpoint to the browser. Real CLI canvas/video tests do not establish browser WebGL or interactive presentation parity.
