# Human rig inspection and modeling touch-up direction

## Product boundary

The delivery unit is an existing output folder or an optional curated review package handed from an agent to a person. This reusable app owns inspection, reference comparison, annotations and feedback export. Upstream compiler, splitter and runtime remain their respective tools. The existing producing agent needs no change to open its output here.

The person uses one inspection workspace with **Setup** and **Animate** sections and a review dialog for feedback (the compare page keeps **View**, **Rig**, **Playback** and **Feedback** sections). Setup covers setup geometry, source art, pivot/joint placement, meshes, weights and draw order; Animate covers angle coverage, frame intervals, reference video/poses, contact/deformation, audio inspection and the inspection environment (wind, gravity and impulses through the published player's `environment`/`moved`; its state is feedback context, never a model or motion edit) and the physics tuning panel (#103: constraint values edited as config patch ops and applied through the producer, never written into the model by review), and the readings block (#108: the compiler's own `rigc render` readings of the drawn animation, run on the inspected build and on the latest scratch build, shown as timeline ticks and worst-frame lines), the Environment block's *Use for readings* (#112: the controls exported as a `rigc-environment/1` schedule that readings, Apply's check and *Check under this world* — the installed producer's `rig-parts check --environment` — read, so the bars and readings are taken under the wind the person watched; the schedule is feedback context and is never authored into the rig), and the requirements block (#113: the scene's declared requirements written as a `spine-parts-requirements/1` file and measured by the installed producer's `rig-parts check --requirements`, one worst-frame line each). Time/angle controls navigate inspection. Timeline edits are six typed keyed operations on a scratch copy of `motion.animations_from`, built by the installed producer; review never writes source motion. Implemented modeling instruments send bounded changes through the installed producer into scratch, including setup-space mesh deltas.

## Core UI rules (owner, 2026-11-11)

These rules govern every Review view and all job kinds, including parts, interview,
plan, checkpoint, rig, direction, image review and signoff.

- **R0** Every Review UI addition or change requires the owner's ruling twice.
  The owner rules on the layout before implementation and on the working screen
  before merge. Show both through the Review tool or a local page. Chat images
  cannot serve this review. HQ acceptance alone is insufficient. This covers
  screens, gates, input fields, toolbars, panels and owner checkpoints, including
  Create-side changes that make Review render new owner content, gates or
  checkpoints. Nonvisual bug fixes are exempt.
- **R1** Every review view separates its main toolbar and secondary toolbar into
  distinct areas. Group primary inspection actions in the main area and auxiliary
  controls in the secondary area.
- **R2** Comments are the only feedback-input feature. A submission can contain
  any number of comments. Each comment can be general or pinned to an image
  point, region, part, frame or checkpoint. Keep pointed image comments through
  `stage-comments.ts` and `parts-comment-crops.ts` with their source-bound evidence.
  Remove separate memo, note, per-part note, summary and `words` feedback input
  surfaces. Survey answers are a separate input kind. Preserve interview
  selections, inline Other text and per-question note inputs through the existing
  interview answer contract. R2 applies to feedback inputs.
- **R3** Inspection uses the main view's Difference switch to cover all regions.
  Remove separate sidebar key-region checkpoint and evidence panels. Retain the
  supported checkpoint act flow through its existing contract.
- **R3a** Any main view in rig, comparison, parts, job, interview or package review
  has a resizable bottom panel directly beneath it. Use one control set in this
  order: **Zoom in → Zoom out → Fit → 1:1 → View switch**, with the same names and
  behavior across views. Use the shared viewport implementation and extend it
  for missing behavior. Keep main-view code shared across screens.
- **R4** All view areas share zoom, Fit, 1:1 and resize behavior through the existing
  viewport modules. Extend the shared modules for a missing capability.
- **R5** `web/index.html` is the single web entry for every screen, including rig,
  comparison, parts, interview, package, job, hub and owner workspaces. Compose
  these screens from a shared workspace shell, main view (viewport and controls),
  resizable bottom and side panels, main and secondary toolbars, view switcher,
  inspector and comments components. Do not introduce a screen through a new
  HTML page or per-screen server route. Preserve existing public job, hub,
  language and capability URLs as redirects or routes into the single entry.
  The owner rules on the shared shell layout before implementation.

The main-view consistency requirement is retained verbatim.

```text
메인 뷰를 넣을거면 기준을 항상 규일하게 가져가(지침) * 메인뷰 하단 패널 리사이즈 * 뷰전환 기능 통일, * 에인뷰 코드가 하나가 아니라 여러개 복붙인지 확인
```

The single-entry architecture requirement is retained verbatim.

```text
뷰는 index.html 단일 진입점 하나고, 컴포넌트 조합으로 화면을 만들어내(ide like) 이거 안되면 진도 빼는거 의미없어, 이미 열린 헬 게이트를 더 활짝 여는 꼴이라고
```

Act-field and downstream-consumer changes follow the existing HQ approval boundary
for public contracts. Preserve historical record parsing, source binding and
replay, with the original recorded text intact. Keep the frozen payload definitions
in their contract references until an approved change maps the comments feature to
those fields. [Live job contract](REVIEW_PACKAGE.md#live-job-contract),
[Public API stability](STABILITY.md).

The owner's wording is retained verbatim.

```text
위 지적 사항은 리뷰 UI 핵심 지침이야 모든 작업에 일관성 확보될 수 있게 기획을 업데이트 하거나 지침을 갈아 앞거나 해줘
파츠 리뷰 툴바 * 툴바 메인 툴바 보조 툴바 영역 구분
사용자 피드백 * 메모 기능은 모두 삭제, 모든 사용자 입력은 코멘트 하나로 통일
```

The owner's UI ruling requirement is retained verbatim.

```text
HQ는 리뷰 UI 추가/변경은 오빠 판정 무조건 받아
```

The owner's comments clarification is retained verbatim.

```text
코멘트가 왜 하나야? 미친거야?
```

The owner's survey and comment distinction is retained verbatim.

```text
설문과 코멘트는 다른 종류의 입력이야 / 설문은 여기 어떻게 할까요? 이고 / 코멘트는 유저가 여기 이상하니까 꼬쳐주세요! 라는 의미
```

The earlier shared-view requirement is also retained verbatim.

```text
뷰영역 공용 UX(리사이즈 등)
```

## Implemented foundation

The CLI opens `review.json` or an existing output directory. The directory adapter builds a manifest in memory from `skeleton.*`, `motion.json`, `report.json`, source video, contact strips and canonical pose-sequence evidence. It never changes delivered output. A compiled model uses the published play runtime. Raw Spine output is evidence with playback explicitly unavailable. Source-only data never becomes a fabricated playback success.

Inspection supports local references, checkpoint context, runtime playback when a real compatible model exists, available angle/audio facilities and explicit review state. The canonical `rig-pose-sequence/1` format documented by `@rig-c/pose` preserves frame times, person IDs, joint states/coordinates/confidence and optional camera metadata. The demo pose is an authored synthetic transport example, not extracted from footage.

Each review submission collects feedback through the comments feature under R2 and can contain any number of general or pointed comments. Source-bound inspection context records an inclusive integer frame interval, or explicit seconds when a frame/interval is unavailable, the target `{kind: bone|slot|rig, name}`, category `defect|quality`, checkpoint, time, reference/person and camera/axis state. The person can export data and issue-ready Markdown; this app neither posts issues automatically nor writes proposed motion keys. Comments must be useful to the producing agent without interpreting a free-form key-edit JSON blob. Existing serialized feedback and comment fields follow the compatibility boundary above.

Identity, revision and content hash bind every decision. A submission also records separate exact rig/motion hashes and paths, packageRevision, viewerVersion and installed runtimeVersion; absent source stays null. The producing agent can retrieve the saved JSON with the read-only feedback CLI after the UI closes. Opening never means reviewed. The person explicitly approves, requests changes or returns to pending, independently of checkpoint outcomes. Changed inputs do not inherit prior approval. Feedback writes remain outside source, are bounded and atomic, and require the app's exact Origin.

## Retarget tuning (#114)

Animate's Retarget block edits what a pose retarget is made from — the `rig-pose-map/1` (per chain, the bone that carries each segment), the clean and retarget flags and the declared sequence — and hands them to the installed `@rig-c/pose`, which writes the motion in scratch; review authors no keys and never writes the package's `motion.json`. The block is the "point → rebuild → watch → repeat" loop of the modeling instruments applied to motion inputs: the producer's refusals come back by name, the built animation plays beside its reference, and its FEET / STANCE / FLIP / SHORT / END-ON / LEG-SCALE / REACH lines seek to their frames. Timeline edits use `set_key_time`, `set_key_value`, `set_key_curve`, `set_key_ease`, `insert_key` and `delete_key` through the shared scratch runner (`src/animation-ops.ts`), never on source files.

## Modeling touch-up direction

The chest-region editor and Edit Mesh exist for detail that cannot be said in words. Issue #99 states the loop: **point → rebuild → watch → repeat → submit**. Review builds no mesh itself; **Apply · Rebuild runs the installed producer as a child process** on the user's own designation, into a scratch build beside the inspected one, and the viewer reloads that build in place. Captured applied evidence (`context.applied`) remains bound to the state that was being watched when it was collected. Submission preserves that captured state. Apply followed directly by Submit does not automatically add the latest applied state to feedback. A unified described/made handoff remains separate work (#369 / create#91), not an automatic transfer promised by this workspace. Edit Mesh sends a typed setup-space delta through `rig-parts remesh --delta` and the shared compile/check runner, loading the scratch revision in place; producer refusals remain named.

Every Apply needs a binding to what the inspected rig was built from (issue #101): the **producer handoff**, declared (`open --config`, or the review.json `producer` block) or found at fixed places (`config.json`, `rig/config.json`, and last `../config.json` beside an opened `out/`, which the bar names as outside the folder). Its files are hashed into the reviewed identity beside the package, and once per session a **baseline** rebuilds the whole rig from them and says whether it reproduces the inspected one. An op that rebuilds the whole rig runs only on a reproduced baseline (`EDIT_BASELINE_MISMATCH` names the first differing path); `remesh` checks its own part (`REMESH_BASELINE_MISMATCH`). A patch that touches only what `rig-parts retune` splices — constraints, the idle's tracks and duration, the blink's numbers — runs retune instead (parts 1.44.0+, #136), which holds every other byte of the inspected rig itself, so a build whose repair is a mesh the config does not reproduce can still take a physics or idle edit — but not one whose repair redrew an image, which retune holds too, nor one whose rig.json is not the writer's text (#148; the baseline line says which); bones, stops, regions, turn and the blink's groups and still keep the whole-rig path and its guard.

Edits reach the producer as data (issue #102): config-based edit cards state their edit as one **config patch** (`rig-review-config-patch/1`: the config hash it was made against, JSON Pointer ops, the producer and the op), and one generic runner applies it to a scratch copy of the handoff config, runs the op (`rig` for the whole rig, `remesh` for one part's entry), compiles and runs `check` on the result. Mesh deltas, retarget requests and keyed motion operations retain their own typed artifacts and runner paths; they are not flattened into config patches. A stale config patch is refused (`EDIT_PATCH_STALE`) rather than rebased. The page's client exposes `applyPatch(patch)` with #99's stream, in-place reload and Reset; the physics tuning panel (#103) is the first editing UI that produces them. For evidence captured while that patch build is drawn, `context.applied` retains the patch, its hash, the producer's line, check's summary and the rig.json diff. Submit preserves the captured state rather than replacing it with the latest Apply.

Physics tuning (#103) edits only what the handoff config declares: a constraint row is resolved by `name` (and kind) against the config, never by index alone, and every op records both the index (its pointer) and the name, which the server checks (`EDIT_PATCH_NAME_MISMATCH`). Rows the rig stage adds (the `turn` twins) have no config field and are shown not editable with the reason. An Apply reloads under the world it was pressed in so before and after are seen under one wind, gust and jolt state; review judges no value (a mass of 0 is rigc's `A23` to refuse). A build whose check FAILed may be loaded and looked at, but a review written on it is not submitted (`EDIT_SUBMIT_UNCHECKED`). Published Play 1.14.0 supplies the six-field live preview (#206): strength, damping, inertia, wind, gravity and mix use its public set/read/clear methods; mass and component toggles still require Apply. Slider input updates the pending override; the label distinguishes it from the last evaluated effective values. The next evaluation uses the patch; a paused page explicitly re-poses the held time without seeking. Clear removes overrides while preserving pending ops and integrated history, and authored values resume at the next evaluation; it does not undo the old trajectory. Apply and model replacement clear the preview. It is labelled "preview — Apply decides" and is never recorded as applied state. Play replays the current standing patch, not historical edits: backward seek recomputes with today's patch, and a newly opened track's first authored pose precedes its pending patch. The readout's BEFORE for the inspected build is that build's own check: once the baseline reproduces, `rig-parts check` runs on the baseline output (byte-identical to the inspected rig) in the background, and its summary is stored beside the baseline record.

The producer writes motion in scratch; review never writes a source key. A timeline edit (#235) is a list of ops on a scratch copy of `motion.animations_from`, built by the installed producer. Idle tracks (#104) edit the idle the producer keys, never the package's motion.json: every edit is a config patch op at `/motion/tracks/<i>/…` or `/motion/blink/…`, and the producer (`retune` on parts 1.44.0+, else `rig --config`; then `check`) writes the keys. The panel offers only what the producer accepts where its rule is closed — a period is `motion.duration / n` (rig-parts `periodFits`: the duration over the period within 1e-9 of a whole number) — and pre-checks the pending idle under the producer's own names and words (`CONFIG_PERIOD_DIVIDES_DURATION`, `CONFIG_BONE_PROPERTY_KEYED_ONCE`, `CONFIG_NAME_RESOLVES`, `RIG_BLINK_INSIDE_IDLE`), so a refusal before Apply is the producer's line, and the producer judges again on Apply. The preview (decision on #104: allowed) drives the edited bones through play's `adjust` with the producer's sine `v(t) = base + amp·sin(2π(t/period − phase))` on the bone the inspected idle keys (`<bone>_ctl` under ctl keys, read off the handoff rig, never guessed: a property the idle does not key yet is refused by name, `IDLE_PREVIEW_TARGET_UNKNOWN`); it uses Play 1.14.0's `BoneAdjust` context `trackTime` through both composed adjustments, with no displayed player clock or seek-compensation re-pose. Bit-exact seek/continuous equivalence requires the unchanged patch, animation, environment, reset and step partition. It is labelled "preview — Apply decides", is cleared on Apply and Reset, and is never recorded or submitted. Blink edits are eased keys and are not previewed.

The Mesh panel (#106) edits one part's `meshes.<part>` entry as the producer's config loader reads it and rebuilds that part with `remesh --mesh`; it is a mesh-density and region editor for the producer's own parameters, not a mesher — review triangulates nothing, and the only geometry it writes is region points (whole rig px) and circle centres. The submitted patch is exactly one op, `replace /meshes/<part>`, so nothing else in the config can move with it. It offers the modes whose fields it draws (grid, contour); `influence` waits until the producer documents it in `remesh`. Its pre-check is the config loader's rules in the loader's names; what the rig stage measures (the keep-radius floor, bridges, heat sources, the remesh rules) is the producer's to say, and comes back verbatim. After a build, three counts must agree — `remesh.json`'s after-count, the revision model's triangles and what the overlay draws — and the panel names each, so an overlay still drawing the old mesh is visible as a disagreement, not hidden.

Readings (#108) are watch instruments, not edits and not gates: the chosen pairs go to the installed compiler as names, `rigc render` reads them on the inspected build and on the session's latest scratch build, and review only draws what rigc wrote — the frames each reading's JSON lists as ticks (set-equal, two colours) and its worst frame as one line. Review decides nothing about the rig's names: an unknown slot or bone is rigc's refusal, shown verbatim. `--angle-range` writes no file, so its ticks come from its printed line (lowest and highest frame). The Environment block's wind and gravity are passed as a one-step `--environment` schedule only while its controls are applied and the installed rigc lists the flag; a time schedule (#112) is outside this card.

Future modeling interactions should select actual parts, bones, pivots and mesh vertices in the posed view, inspect weights and ordering, and adjust bounded setup geometry with before/after comparison. Angle inspection needs declared axes and measured coverage; one scalar animation dial does not establish compound view synthesis.

The modeling requirements to preserve are local mesh-density adjustment, edge/curvature refinement, direct source-image comparison, a chest-region center/radius control, an integrated parts viewer with preset switching, and a face/body angle deformation sweep. These need actual geometry/source evidence and explicit acceptance criteria; they are not implemented by illustrative controls or a successful parser load.

Any future modeling edit needs provenance, undo/redo, explicit units and an exportable patch identifying the original hash and authoritative authoring target. A named adapter must apply it and rerun the owning tool's validation. Compiled-model rewrites are insufficient when source files are authoritative; conflicts must be named. This is a future modeling requirement, not permission to build a motion authoring tool.

## Acceptance progression

1. Delivery and feedback: one command opens unchanged output; declared assets load; comments with source-bound inspection context save and export; changed source invalidates approval.
2. Runtime inspection: a real gated artifact plays and seeks through the public runtime, survives reference and Inspector section changes and names missing dependencies. Source-only fixtures cannot close this item.
3. Modeling touch-up: a bounded real geometry edit round-trips into authoritative source, reruns its gate and presents measured before/after evidence with undo/conflict controls.

## Screen prototype

[design-prototype.html](design-prototype.html) preserves the interactive screen concept. It is **illustrative**, with sample controls/data, separate from the implemented app. Its older motion key/curve editing concept is superseded by the current view/annotate/export boundary. It does not demonstrate completed mesh, motion, angle or audio editing.

## Workspace layout

The single review page is one inspection workspace: a left column, the stage, the Inspector under the stage and one status footer. There is no right panel.

- **Left column.** A fixed header row (Parts title and slot search on one line; the search's name, *Find slot*, is its `aria-label`) and one scrolling body. Nothing sits above the header and it never scrolls. The body holds the reference select, the part list and browser Settings; it is the column's only scroll container. Region coverage and Difference inspection stay in the main view under R3. Settings opens and closes from its own header (`#settings-toggle`, `aria-expanded`, controlling `#settings-body`); it starts collapsed and the state is a browser preference.
- **Header.** The **Setup** / **Animate** mode switch sits next to the package title and is the Inspector's only section control: its buttons carry `data-inspector` and `aria-pressed`, and every section change (click, `showInspector` from a part selection or a tool, a restored bookmark) goes through them. On the right, **Write review** (primary) opens the review dialog. The top bar has no feedback export buttons; `rig-review feedback --format json|issue` is the export path.
- **View bars.** Distinct main and secondary toolbar areas follow R1. Group the persistent image / mesh edges / bone points layer toggles (keys `I`, `M`, `B`), camera sync, zoom and the **View** menu in the owner-ruled layout under R0. The **View** menu remains a `<details>` holding Side by side, Reference and Rig, labelled with the effective choice. Each area wraps when the stage is narrow so every control stays in reach. The toggles stay native checkboxes, so their checked state is the pressed state, the draft input and the `layers` control value. A disabled toggle names the footer's layer reason as its tooltip. Turning images off leaves the mesh/bone overlay alone. Appearance lives only in Settings (its Theme select shows the inspection's current appearance and drives it), the per-inspection Repeat idle toggle lives in the Animate transport row, and there is no Copy view link button: the persisted `#review=` fragment stays in the address bar and the numeric region stays behind **View region**.
- **Panel headers and scrolling.** The left column's header is a fixed row outside its scrolling body. The Inspector heading, the Settings title and each drawer's header (title and close) carry `.sticky-header` and are their panel's first child, so the body scrolls beneath them. Every scrolling region shares one thin scrollbar rule on `*` whose colours are the `--rv-scrollbar-*` tokens. Resize separators are drawn 4px with a 16px transparent hit area (22px on coarse pointers) and use `--rv-separator` / `--rv-separator-hover`, never a scrollbar colour.
- **Chest-region editor.** In Setup only, the view bar's **Chest regions** toggle (`#chest-edit`, `aria-pressed`) opens `#chest-editor-bar` under the view bar: R / L groups (X, Y, R, Band), Mirror R → L, Download JSON, **Apply · Rebuild** and **Reset**. Apply sends the rows to the installed producer (`rig-parts remesh` on that part, then `rigc build`) through `POST /api/rebuild` (`src/rebuild.ts`, `src/producer.ts`) and loads the compiled scratch build in place; the producer's lines stream into `#chest-editor-status` and `#chest-editor-log`, a refusal shows its first named line verbatim, and Reset returns to the inspected build (README, *Chest regions*). The circles, their centre / core / band handles and labels are drawn on `#rig-overlay` through the crop → world mapping; handle drags (move, r, band) are clamped live with the example rebuild script's non-overlap rule (`CHEST_REGIONS_CLAMPED`) and never move the camera, while other drags and Space-drags pan. The values are the Setup **Chest regions · detail** block's fields, so its draft, export and binding apply unchanged; the block keeps names, bones, semi-axes, clip and the contour. Review builds no mesh: the rebuild is the producer's, into scratch under the state directory, never into the package. A **Circles** / **Landmarks** switch (`#bust-mode`, a hidden input the draft keeps) selects what Apply sends: Landmarks (#105) places the right apex, left apex and cleavage with draggable markers (`#lm-*`), alpha and clearance sliders and optional bone names, draws the producer's derived `bust_r` / `bust_l` live (`src/chest-landmarks.ts`, a transcription of parts' `deriveBustRegions`) and sends `{part, bust, configHash}`; review pre-checks only `CONFIG_BUST_CLEARANCE` and leaves bones and names to the producer.
- **Mesh panel.** In Setup, after Chest regions · detail: `#mesh-panel` for the selected mesh part — mode-specific sliders with number fields (`#mesh-params`), regions (`#mesh-regions`; **Add circle**, **Draw polygon** and **Drag on stage** with `aria-pressed`), segments (`#mesh-segments`, bones from the loaded model, ribs stations per chain), the pending diff (`#mesh-diff`), the pre-check (`#mesh-precheck`), **Apply** / **Reset** / **Folds reading**, the status (`#mesh-status`), the counts (`#mesh-counts`) and the `TEXTURE_STRETCH` readout (`#mesh-readout`). Region colours are theme tokens (`--rv-mesh-region`, `--rv-mesh-region-fill`, `--rv-mesh-handle`).
- **Weights.** In Setup, after the Mesh panel: `#weights` (#107), a watch layer. **Show weights** (`#weights-show`, `aria-pressed`) draws the selected slot's setup-pose mesh on `#rig-overlay` with each vertex coloured by the picked bone's stored weight (`#weights-bone`, influencing bones first) on the ramp tokens `--rv-weight-0` / `--rv-weight-half` / `--rv-weight-1`, or by its dominant bone (`#weights-mode` Max influence, `--rv-weight-bone-1…6`); `#weights-legend` and the hover readout `#weights-hover` sit under it. Weights are read from the compiled model document (`src/weights.ts` over the shared reader `src/setup-mesh.ts`); positions, triangles and hull come directly from published Play 1.14.0's `readSetupMesh` (`web/setup-pose.ts`, shared with Edit Mesh), including selected setup-slider deform. A never-played `RigPlayer` reads only public setup identity; its active skin selection stays distinct from the supplying table, and null identities are never guessed. A package without the document refuses `WEIGHTS_MODEL_UNAVAILABLE`. No edit, Apply or record; the Mesh edit preview wins when both are on.
- **Bones.** In Setup, after Weights: `#bones-panel` (#109). **Edit bones on stage** (`#bones-edit`) draws the handoff config's bone anchors — `at`, chain `points`, `tip` — on `#rig-overlay` through the crop → world mapping (tokens `--rv-bone-line`, `-origin`, `-point`, `-tip`, `-pending`, `-selected`, `-ink`, `-label-bg`; the stage stays dark in both schemes, so both blocks carry the same values). A drag moves an anchor by whole rig px; each move is a `replace` op at its JSON Pointer naming the bone (`src/bone-anchors.ts`, `web/bones-panel.ts`). Check (`POST /api/bones-check`, `src/bones-check.ts`) runs `propose --from-config` and `compare` on a scratch copy of the patched config and shows their lines as printed; a LINT line blocks nothing. Apply is the generic patch runner's whole-rig `rig` op behind the reproduced baseline. Adding, removing or re-parenting bones is out of scope.
- **Rig fields.** In Setup, after Bones: `#rig-fields` (#110). The producer config's small fields as patch ops at their own pointers (`src/rig-fields.ts`, `web/rig-fields-panel.ts`): a rigid part's bone (`/regions/<part>`, a select), a lash's blink still row (`/motion/blink/still/<part>`, a dashed line across the part dragged in whole rig px), a stop's inward / outward bounds (`/stops/<i>`, two filled arcs at the pivot around a dashed rest aim, their ends dragged in whole degrees), an inherit mode per bone (`/bones/<i>/inherit`, a chain's `link_inherit`) and `turn`'s pivot and per-part depth (`/turn/pivot`, `/turn/depths/<part>`, sliders). Stage handles live in `#rig-fields-stage` over the rig viewport (tokens `--rv-field-still`, `-inward`, `-inward-line`, `-outward`, `-outward-line`, `-rest`, `-handle-bg`, `-ink`; the stage stays dark, so both blocks carry the same values). The turn dial holds the drawn build's `turn` bone at x through play's `adjust`, composed with the idle preview, and shows `#rig-fields-dial-label` (*preview — Apply decides*); it is never recorded. Apply is the generic runner's whole-rig `rig` op behind the reproduced baseline; the readout quotes `BLINK_NO_HOLE` and `FEET_STAY_LEVEL` before and after, and **Angle range** runs one #108 reading. Adding a stop and `turn.deform` are out of scope.
- **Cloth.** In Setup, after Cuts: `#cloth-panel` (#111). One form per cloth tag the installed reader accepts (`bottomwear`, `back hair`, `front hair` — its own `CLOTH_TARGETS`), holding the recipe's fields as the config states them; each change is a patch op at `/cloth/<tag>/…` (`src/cloth-recipe.ts`, `web/cloth-panel.ts`). **Show links** draws, in rig px of the setup pose, every chain the tag's parts are meshed on from the config's `points` and `tip`, and after an Apply the chains of the config the producer wrote (one label per set). Apply runs `rig-parts propose --cloth --write-config` on the declared parts, painting and keypoints, then builds the written config (`build` when the config declares `limbs`, else `rig --config`) and reloads it under the stage's Environment. Review never merges the producer's draft: it reads only the written config, lists where it differs from its input and refuses one that differs outside the drafted sections. Hand-editing the drafted constraints is the physics block's, after the draft.
- **Mesh edit.** In Setup only, the view bar's **Edit mesh** toggle (`#mesh-edit`, `aria-pressed`) opens `#mesh-editor-bar`: sub-modes Modify / Create / Delete / Edges (keys `V` / `C` / `X` / `E`, one pressed), Undo, Redo, Reset, Download JSON and **Apply · Rebuild** (#135: `rig-parts remesh --delta` through the shared runner, the revision loaded in place, the producer's refusal verbatim; while a delta revision is on the stage Reset returns to the inspected build). A package without the compiled model document refuses `MESH_EDIT_MODEL_UNAVAILABLE` and does not open; whole rig refuses `MESH_EDIT_SELECT_SLOT`; a non-mesh or linked-mesh slot `MESH_EDIT_NO_MESH <slot>`. It edits in setup space (#100): the attachment's stored provenance in the model document (`src/setup-mesh.ts`) and geometry from Play's public `readSetupMesh` (`web/setup-pose.ts`, shared with Weights) and drawn over the paused stage with the stage camera. It records a typed delta (`src/mesh-edit.ts`, `basis: "setup"`, the shape `rig-parts remesh --delta` reads) and previews it over the original triangulation on the overlay; Delete removes only constraint edges the delta added (the triangulation is the producer's); it is not a mesher and never retriangulates, writes the package or runs a producer. The chest editor and mesh edit are exclusive: turning one on turns the other off.
- **Inspector.** Two sections and no section tab row: **Setup** is the mesh-review composition (selected part, part presets, the modeling-review proposals for mesh density, contour curvature and chest position) and holds no control that seeks or plays; **Animate** has the transport with the Repeat idle toggle, frame navigation, the motion-review proposals and angle inspection with its axis panel, sound cues and report events. Their element ids and saved section names (`rig`, `playback`) are unchanged. Each section opens with a sticky block row (`.block-row`, `web/inspector-blocks.ts`), a WAI-ARIA tablist: Setup — Part · Modeling · Chest · Mesh · Weights · Bones · Fields · Cuts · Cloth; Animate — Transport (the motion tools and the angle panel) · Sound · Environment · Physics · Idle tracks · Readings · Requirements · Retarget · Report, in document order. Animate's timeline is its own panel beside the blocks, not a tab. Each `role=tab` button controls the `role=tabpanel` block it names: selecting it shows that block alone and hides the others (`hidden`; a block a tab carries, such as the angle panel, by `data-block-hidden`, so its own `hidden` stays its own), and nothing scrolls between blocks. Arrow keys, Home and End move between tabs and select as they go. Hiding writes nothing inside a block, so drafts, pending edits and stage overlays such as the chest editor's are kept while their tab is hidden, and each block keeps its own scroll offset for the session. The row is one line that scrolls sideways when narrow. The active tab per section is the only thing the row adds to the inspection draft (`ui.inspectorBlocks`); the section's scroll offset stays with the Inspector scroll memory, and the control protocol and saved-view link are unchanged. A saved `view` or `feedback` section from older links and drafts restores without selecting a section or opening the dialog.
- **Review dialog.** A native modal `<dialog id="review-dialog">` holds the review status, reviewed source with the read-only source-file list, the comments feature under R2, frame-strip export and the **Submit review** button (`#save`). **Write review** opens it with `showModal()` and pauses playback; Escape or Close dismisses it and focus returns to **Write review**. Comment drafts stay in the document while the dialog is closed, with source-bound autosave, recovery and conflict handling. The modal makes the rest of the page inert, so the dialog repeats the footer's message and draft state in its own status line; the footer keeps reporting both.
- **Footer.** Message (truncated, full text as tooltip) on the left; player, effective layout, renderer, layers, idle, remote control and draft state in the middle; the numeric view region (behind **View region**) and the source hash on the right. The View region body is a `position:fixed` popover above the 40px footer, right-aligned, its width and height clamped to the viewport and its content scrolling inside, so the footer's clipping never hides it and opening it never scrolls the page.

The compare page keeps its own markup and stylesheet: sources left, Parts explorer right, its four Inspector sections, its export buttons and its separator colour. It shares the workspace coordinator, so its separators are drawn at the same 4px.

## Model turn inspection

The Turn pad is a separate inspection surface above the stage, leaving the Rig
fields producer preview unchanged. It reads actual model slider/bone declarations,
uses published Play's BoneAdjust, displays applied and target values separately,
and supports Hold, exact entry, zero reset and the head-turn demo's critically
damped smoothing. Compare uses the common axes and intersection of both ranges,
passing identical numeric values to both players. A separately validated feedback
field and source-bound view state retain applied values; no keys or source motion
are authored. See [Turn pad](PANELS.md#turn-pad).

## Stored animation inspection

Animate’s read-only block under Transport reads the hash-verified compiled skeleton of the build on stage. Timeline, Curves and Bone tree share transport and page-local bone/slot selection. A bone selection highlights its directly attached Parts rows; it never picks an arbitrary child slot. Stage picking uses held drawn geometry and resolved clips. Source-bound slot identity and every existing output/patch format remain unchanged.

The curve path and handles are the stored numbers, without refitting or replacement keys. A separate runtime evaluation cursor/readout applies Play’s Float32 key conversion and ten-piece Bézier evaluation at held player time, then setup addition or scale multiplication in timeline order. Its authored locals precede constraints and previews, so it is not a final world pose. No second evaluated curve is drawn. See [the validation contract](ANIMATION_INSPECTION.md).

## Inspection strips

An inclusive annotation interval can also become a derived frame strip. The single view selects one declared source video; compare retains its explicit shared video and chooses a producer clock basis for each interval. A batch preserves separate feedback intervals and side provenance. Source rows run down the sheet and requested producer frames run across it. A vertical batch repeats this grid rather than merging overlapping annotations.

Exact report `frameTimes` selects the requested seconds. Actual video decoding selects the nearest presented PTS (ties earlier), which drives all rig rows through the same published player/poser and fixed seek step as inspection. Requested frames, decoded PTS and each side's independently known frame remain distinct data. Missing clocks do not become a guessed rate or an empty rendered cell: PNG names the regeneration requirement and JSON can preserve an unmapped selection.

The export uses dedicated real canvas players and leaves the live playhead/session alone. PNG pixels, full source identity/footer and JSON are derived output outside the input packages. Exporting never approves a review or authors motion. Browser download controls share the bounded backend plan; a CLI can render and write new external files without providing a filesystem endpoint to the browser. Real CLI canvas/video tests do not establish browser WebGL or interactive presentation parity.


## Implemented slot inspection and public identity snapshots

The Parts explorer (the review page's left column; the compare page's right one) provides source-hash-bound slot selection, held-pose clipped Solo, Whole/context, conservative bounds fit, a diagnostic selection box, actual mesh/region counts and reproducible selection context. This is inspection rather than geometry editing. All rows use the public held identity snapshot's exact z order, including hidden/null slots. Current source-bound links/drafts and control observations retain side/slot/mode.

Published Play1.14.0 supplies a frozen `slotIdentity()` snapshot coherent with `posedFrame().generation`. Review retains copied frame/identity together only after equal-generation and source-slot/order checks, uses the player's default public filter, and never seeks/reposes/changes physics merely to read identity. Exact owning skin/key, active set/skin and null reasons come from that snapshot, not a unique-declaration or texture match. A resolved identity can remain known without visible geometry or fit bounds. Clip declarations do not invent keys when the API reports no drawable attachment.

A click on the rig view in Animate selects the slot under it, and hovering previews that click (#330): the same hit test (`web/stage-pick.ts` `pickAt`) draws the part's outline and tint with its slot name beside the pointer, styled apart from the selection box, and shows nothing where the click would select nothing. It is display state only, never written to a session, feedback or export. See [Inspect a part](PANELS.md#inspect-a-part).

Selecting the selected row again (click, Space or Enter) clears the selection, the same as **Whole rig**; the control value is then `null`.

Each row shows a 24×24 CSS-pixel thumbnail (2× backing store) of the attachment the held identity snapshot says is active: the region the compiled model's `pages[].regions[]` declares under that attachment's path (or name), cut from the loaded page image by its page UVs. It is drawn when the row scrolls into view and cached per skin/attachment key. A row whose attachment has no such region (no active attachment, a non-image kind, no or several regions of that name, a rotated packing, a page that did not load) shows the type icon, and its tooltip names the reason. A whole atlas page is never a part's thumbnail. Row text and the slot count are unchanged; on the compare page each side registers its own thumbnail source from that side's compiled model and loaded page images. Both pages keep the Parts heading, search input, Whole rig button, Solo toggle and result count in a fixed tool area above a scrolling list of single-line ellipsized rows with uniform height, preserving full row text in `title` and `aria-label`.

Live selection follows a slot. A source-bound bookmark captures its exact identity tuple at that pose; restore validates it after applying time/animation/set and drawing, with transactional rollback on a named mismatch. Old slot-only bookmarks resolve through current public identity. Generation belongs to current readback/feedback, not a stable source target. Named weights and original part alpha remain unavailable without an exact original-source mapping. A conservative bounds box and counts are not source-faithfulness or physics validation.

A future optimization operation sends explicit source-bound selection/bounds to the owning producer. That producer returns a new package revision/hash and provenance including producer version/request identity; Review never regenerates rig, motion or mesh bytes. Candidate Apply/undo/export requires its own implemented contract and acceptance, rather than being inferred from the explorer.

## Workspace geometry and browser preferences

Side and bottom panels have pointer and keyboard separators with separator semantics: orientation, the controlled panel, an accessible name and the actual reachable minimum/maximum/current pixels. Arrow keys act only when the separator itself has focus, so text-entry arrows are never intercepted. A drag holds pointer capture; cancel, lost capture, blur, Escape and disposal restore the previous desired size and release it.

The allocator measures the layout rectangle minus stage chrome and keeps a 240×180 CSS-pixel stage minimum. It shrinks side panels proportionally toward their own minima; when the width still cannot hold them it turns the left, then the right column, and when the height cannot hold it the Inspector, into a native modal drawer opened from a trigger outside it. Effective sizes are computed from desired sizes and never written back; a separator inverts the allocator so a clamped pixel value is not saved as the desktop desire.

Browser defaults live in one closed, versioned record: theme, default camera sync, default idle repeat, whether Settings is collapsed (`settingsCollapsed`, default `true`) and the three desired panel sizes. A record saved before `settingsCollapsed` existed carries neither the value nor its stamp and loads as collapsed at stamp revision 0; the schema name is unchanged. The saved `rightWidth` is the Parts explorer's width wherever the page shows it, so the review page's left parts column keeps the width chosen before the move; `leftWidth` is the compare page's sources column. Each field carries a logical stamp, so stale whole-record writes from other tabs converge per field without wall-clock ordering; an equal-stamp disagreement quarantines only that field until an explicit edit repairs it. Denied, unavailable or corrupt storage falls back to in-page defaults. The legacy same-origin appearance key migrates once, only when no new record exists. Reset layout changes geometry only.

Content state stays source-bound. Each Inspector section's x/y scroll offset is captured before its panel hides and restored after it shows, after two frames of layout, and again when its content extent changes. Restoring clamps to the current extent without replacing the remembered offset, and intentional user scrolling supersedes a pending restore. Offsets are kept in the source draft's UI state, never in the global record or a copied view link.

Browser storage is origin-scoped. Managed opens (the default) share one loopback front origin that routes `/instances/<key>/…` to each worker, so Settings, sizes and drafts carry across reopens; `--direct` keeps per-port origins. Because one origin cannot isolate its scripts, writes require a per-instance capability handed off only in the printed `#cap=` fragment and checked by both the front and the worker; a fragment-less copied link is read-only. Draft scopes carry the source hash, so revisions of one package never clobber each other's drafts.

## Theme

The palette comes from the rig-c.org site stylesheet. Its dark `:root` values (`--bg`, `--fg`, `--fg-strong`, `--fg-soft`, `--fg-muted`, `--border`, `--border-strong`, `--hover-bg`, `--active-bg`, `--link`, `--link-hover`, `--btn-fg`, `--code-*`, `--footer-bg`, `--pass`, `--warn`, `--fail`, the font stacks and `--radius`) are copied into the `:root` block of `web/styles.css` and `web/compare.css`; nothing is fetched at runtime, so the viewer stays offline. The site loads Inter and JetBrains Mono from a font CDN; the review keeps only the family stacks and falls back to local fonts. The site has no light scheme, so the light values and every review-only surface token (`--rv-*`: bars, panels, controls, fields, pressed state, focus ring, backdrop, stage) are review-local derivations of the same palette.

Rules:

- No literal colour (`#hex`, `rgb()`, `hsl()`) outside the `:root` token blocks of either stylesheet. Rules use `var(--…)` only.
- Every colour token is defined for both schemes: `:root` holds dark (the default before any script runs) and `:root[data-theme=light]` redefines the same set. The appearance control resolves `system` through `prefers-color-scheme` and always writes `data-theme=dark|light` on the root element, so the stylesheets carry no per-component light overrides.
- State colours: pressed and current selections use the `--pass` family, primary actions and links `--link`, dirty and draft notices `--warn`, errors `--fail`.
- The stage (pane gradient, grid dots, pane labels, empty-state text, video letterbox) stays dark in both schemes so source pixels and overlays read the same; its tokens carry equal values in both blocks.
- Resize separators and scrollbars never share a colour: `--rv-separator` and `--rv-separator-hover` resolve to values different from both `--rv-scrollbar-*` colours in each scheme (the review page; the compare stylesheet keeps its own separator colour).

`tests/theme.test.ts` enforces the first two rules and the separator/scrollbar rule.

## Comparison eligibility

A layout is offered only for inputs that actually loaded and rendered. One pure decision (`src/comparison-eligibility.ts`) takes load outcomes, never declared paths: the rig counts after its first successful draw, an image after `decode()`, a pose after it parses, and a video after `seeked` at the held time with a decoded frame. A new video stays pending until then; a held time outside its duration is refused as `REFERENCE_OUT_OF_DOMAIN`, never clamped.

Single review keeps the requested layout in the source-bound draft and shows it when usable; otherwise the most useful loaded single pane is shown. Unavailable layout buttons stay visible, disabled, with the named reason as their description, and no placeholder pane stands in for a missing input. Two-build comparison keeps its identity and domain checks: a failed side leaves the survivor as a static single pane with the failed side named, feedback needs the settled pair, and a real zero-duration domain allows static inspection without playback. Modeling-candidate comparison is reported as unavailable (no producer handoff); no candidate UI exists. Remote observation reports the requested and effective layouts and each reason.

## Four inspection stages

The same numbered navigation appears on parts, compiled and compare inspections:
1 Parts + mesh, 2 Interview, 3 Rig + animation, 4 Direction. These are navigation,
not create pipeline stages or sign-offs. Opening or switching never submits a
verdict, applies an edit or starts a producer job. Interview and Direction name
their missing consumer contracts; no tools are fabricated for them.

### Standing live job boundary

`src/job-contract.ts` freezes the semantic live-job boundary (`JOB_API_SCHEMA` set to `rig-review/job-api@2`, `JOB_ACT_SCHEMA` set to `rig-review/act@2`, [Review #484](https://github.com/rig-c/review/issues/484)), backed by the implemented backend session/store (`src/job-session.ts`, `src/job-source.ts`, `src/job-act.ts`, `src/job-api.ts`), standing loopback job front and browser window runtime (`src/job-front.ts`, `web/job-session.ts`), and `rig-review session open|publish|ask|next|close` CLI (`src/entry.ts`, `src/job-cli.ts`). The public installed managed-host entry is `@rig-c/review/job-host` with frozen exports in [Public API stability](STABILITY.md#managed-owner-host), and Create's production publication reader and writer-owned sibling `fetch-act` readback remain pending [Create #184](https://github.com/rig-c/create/issues/184). See [Live job contract](REVIEW_PACKAGE.md#live-job-contract) and [Standing live job workflow](WORKFLOWS.md#standing-live-job-workflow).

- **One standing window and owner visual gate.** Every owner visual, question, choice, correction and verdict goes through one standing Review window/link plus one what-to-look-at line. Internal agent and HQ media remain internal. A missing required visual (`visual.status` set to `'unavailable'`) is an immediate stop plus a Create-filed on-path Review card, never a chat fallback.
- **Human UI authority vs agent verbs.** People submit finalized acts through the browser UI (`actor` set to `'human'`, `channel` set to `'review-ui'`) under a bootstrap-declared `reviewer` (`id` and `role` as `'owner'` or `'delegate'`). That reviewer binding is declared by trusted host bootstrap, cannot be typed or overridden in the browser UI, represents provenance rather than keyboard-user authentication, and maps to Create's existing `by` authority. Agents use `publish`, `ask`, `next` and `close` with `expectedGeneration` CAS and `idempotencyKey`. `publish` requires an explicit producer-held freeze (`freeze.kind` set to `'producer-held'`, `holdId`, `record`) held until acknowledgment as a caller obligation, with no watched-root or automatic-close guarantee. Only explicit `close` ends an active job.
- **Exact displayed source, cursor replay and draft retention.** Finalized acts and job events replay through durable cursors (`next` and `subscribeJob`). The daemon derives `JobSourceBinding` from validated retained bytes and the page-scoped `displayedNonce` receipt rather than browser-supplied hashes. When a new publication updates the displayed source, old local drafts remain retained for their original source binding and are flagged without rebinding onto the new publication.
- **Enabled vs reserved act kinds.** Five act kinds are enabled (`interview-picks`, `checkpoint`, `parts-verdict`, `review-verdict`, `signoff`) while `described-correction` (awaiting the joint [Create #182](https://github.com/rig-c/create/issues/182) context allowlist) and `mesh-edit` (awaiting the joint [Parts #1159](https://github.com/rig-c/parts/issues/1159) freeze) stay reserved and disabled (`JOB_ACT_KIND_DISABLED`). Checkpoint acts carry `pass` or `fail` only (`pending` is UI draft only) and require `words` as a string preserved verbatim including empty or whitespace-only text, with `planStepId` copied by the daemon from the validated ask and stage derived by Create. Signoff acts carry `approved` only with required verbatim `words` (empty or whitespace-only allowed) and remain separate from verdicts and Create stage transitions. Plan-bound signoffs (`plan-approved`, `rigging-interview`, `post-interview`) and checkpoints use step IDs and hashes published by [Create #184](https://github.com/rig-c/create/issues/184) without Review recomputing `stepHash`. C4 binds the exact public `partsFileReferences(dir)` array from `@rig-c/parts/src/parts.ts`, whose contract is frozen at Parts 2.25.0. The trusted host resolves an installed version in `JOB_PARTS_ENUMERATOR_RANGE` (`>=2.25.0 <3.0.0`), supplies its actual version and official callback through `partsEnumerator`, and declares `partsEnumeratorId`. `JobPartsIdentity.enumeratorVersion` carries that actual version. Manifest paths are work-root-relative and image paths are relative to the manifest directory. Each image carries `path`, bounded-string `role` and raw-byte `sha256`. Review compares the claimed array positionally with the official array, preserving its role/order/duplicate semantics. Upstream roles include `part`, `alternate`, `depth`, `painting` and `figure_mask`. Review bounds shape and paths, refuses traversal/symlinks, decodes PNGs and hashes retained bytes. Missing references refuse with row, role and path, including a missing sibling figure mask when a render copy exists. Unreferenced extras stay outside this parts identity. Composite source hashes use `rig-review-job-source/2`. Create #184 production reader/projection and official-hook wiring remain pending.
- **Writer-owned sibling fetch, public host seam and legacy file handoffs.** [Create #182](https://github.com/rig-c/create/issues/182) and [Create #184](https://github.com/rig-c/create/issues/184) own direct writer publication and `fetch-act` reads via a private writer-owned sibling binding outside `project.json` (`writer-owned-sibling-fetch-capability`, pending Create #184 production reader/writer integration), never tracked in version control or unstaged project output, never constructed or carried by agents, dead at explicit `close`, and renewed on each job incarnation. In the public managed-host startup seam (`startJobHost` from `@rig-c/review/job-host`, frozen in [Public API stability](STABILITY.md#managed-owner-host)), hook-bearing host callers declare `readerId`, `bindingId` and `partsEnumeratorId`; equality plus API/act schemas and actual enumerator version govern authenticated active-listener reuse and missing or mismatched IDs refuse by name (`JOB_HOST_OPTION_ID_INVALID`, `JOB_HOST_REUSE_MISMATCH`) with no function hashes. Future mesh acts will be fetched by Create and passed in process to Parts' public exported API owned by [Parts #1159](https://github.com/rig-c/parts/issues/1159) without Parts reading Review or Create storage, while standalone `--delta` remains legacy outside the active cycle. Agents never build, parse, reshape or carry Review session, picks, verdict or applied-record storage files, and existing `--picks-file`, saved verdict path, reshaped feedback JSON and `--verbatim-file` handoffs are legacy/history bypass findings for the active cycle.
- **Direction scope.** Direction carriage in `#484` is metadata-only and distinct from [Review #482](https://github.com/rig-c/review/issues/482) preview and [Review #483](https://github.com/rig-c/review/issues/483) actual plated take playback, while [Review #373](https://github.com/rig-c/review/issues/373) remains parked.

Stage 1 in a single compiled inspection with a producer handoff shows the
handoff's **separated parts and draft meshes**, labelled **Draft rig · structure
evidence only**. It proves each part's original raster crop against the rig image
and binds its exact skin/slot/attachment, dimensions, UVs and triangle indices to
the compiled mesh. UV values compare as exact float32 values, including the
compiler's shortest round-trip decimal representation; no numeric tolerance is
used. A name alone is insufficient. This is structure inspection, never final
rigging approval or evidence of unmeasured compiler gates.

Choose **Chest regions**, **Mesh parameters** or **Edit Mesh** on the selected
part to open the existing Setup precision instrument. The part and exact
`rig-parts remesh --mesh` or `rig-parts remesh --delta` operation remain visible.
Apply/Rebuild and Reset are the existing producer-backed actions. Return with
**1 Parts + mesh** to inspect the revision actually drawn by the parent, including
a checked scratch revision. Each entry reloads against that explicit build ID;
a pending candidate or the server's unrelated latest build is never substituted.
Reset returns to the inspected revision. New scratch reads and made-mesh feedback
submissions recheck pinned producer inputs, revision files and compiled files.
A changed scratch input cannot inherit clean checked evidence.

The embedding is read-only: original verdicts and comments are never copied onto
scratch geometry or saved by navigating. Use the standalone `parts` command for
its separate explicit original-parts sign-off. Parts-only inputs remain
inspectable and name `STAGE_DRAFT_UNAVAILABLE` for direct correction. A missing
handoff keeps the inspected atlas available where supplied. Compare retains its
read-only, side-specific inspected atlas. Neither flow guesses a sibling draft.

Named draft boundaries are `STAGE_DRAFT_UNAVAILABLE`, `STAGE_DRAFT_MISMATCH`,
`STAGE_DRAFT_STALE`, `STAGE_DRAFT_CHANGED`, `STAGE_DRAFT_UNCHECKED` and
`STAGE_DRAFT_OPERATION`. Producer discovery and its named missing/old-producer
refusals are unchanged; Review never installs a producer. Correction-record
export remains unavailable pending review#369 and create#91. Existing reviewer
requests remain verbatim in their existing feedback/comment contracts; there
is no fake Apply for art repair.

Only Stage 3 shows the legacy Setup, Animate and Compare switch; its existing
instruments, DOM and mode IDs are retained. In Stage 1 a compare session keeps
the A/B source picker usable and shows the selected side's cached atlas frame.
**Open setup mesh instruments** returns from the atlas to Setup; it does not
rebuild. Existing bookmarks, Apply/Reset provenance, selected slot, compare side,
time, pending edits and applied build stay owned by those original tools. Stage
changes retain the original workspace and each compare side's atlas controller.
Single draft frames are rebound on revision changes. Language changes update retained
frames without applying or submitting.
The parts-only entry retains its part selection, geometry and pending verdict
while visiting unavailable stages; it needs no compiled model.


## Shared parts viewport and comments

Standalone pre-rig parts and the compiled Stage 1 atlas frame mount `viewport-pair.ts`'s actual
rig/reference DOM. `parts-viewport-provider.ts` supplies raster geometry and painting-crop pixels;
`viewport-controller.ts` and `view-controls.ts` own camera writes, cursor zoom, pan, fit, resize
and the common two-pointer pinch. Parts' native scale policy is separate from the unchanged
compiled-rig Fit-relative policy. `parts-render.ts` remains the source of part, footprint and
mesh painting. The optional protected `--painting` input supplies the real reference crop;
A/B and adjustable-opacity Overlay share the original painting
transform from declared rig/source canvas geometry, with exact fractional placement. This is a visual
comparison using browser interpolation, not native pixel parity with the producer's resampled raster.
Difference uses the producer-declared rig-space painting artifact; see [Declared-grid Difference](PARTS_VIEW.md#declared-grid-difference).
`tests/parts-comparison.test.ts` guards the geometry/settings; `tests/parts-overlay-browser.ts` verifies
displayed overlay pixels and comment restoration in both languages.

`stage-comments.ts` shares capture/composer/pins with a codec boundary for the closed parts
variant; no rig frame/slot/model placeholder is manufactured. `viewport-capture.ts` supplies
displayed viewport pixels, while `parts-comment-crops.ts` cuts native RGBA evidence on the server
from the bound original PNG. `comment-crops.ts` supplies their common PNG validator and immutable
store. [Parts view](PARTS_VIEW.md#pointed-parts-comments) names the format, refusals and the unit
and real-browser instruments that verify these behaviors.
