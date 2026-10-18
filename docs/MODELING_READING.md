# Modeling reading: public parts build and a first inspection slice

Research for [review #15](https://github.com/rig-c/review/issues/15). This is a design input, not an implemented modeling workspace or an acceptance report for the art.

## Evidence and scope

The concrete specimen is `family/naru` in public `rig-c/parts-examples`, pinned to [4991957d9db85b9dee039cb51dfab967b46a502d](https://github.com/rig-c/parts-examples/tree/4991957d9db85b9dee039cb51dfab967b46a502d/family/naru), read on 2026-10-18. Supporting format documentation is public `rig-c/parts` at [a16b322a54fd1fb7f5db69745f9995590580fd86](https://github.com/rig-c/parts/tree/a16b322a54fd1fb7f5db69745f9995590580fd86). The latter documents producer capabilities; it does not add them to the selected older build.

The issue names the owner's manual inspections. Public repair documents corroborate several concrete cases below. This reading does not reconstruct private HQ messages, inspect private builds, execute a build, open a browser, or assess image appearance.

The [Family README](https://github.com/rig-c/parts-examples/blob/4991957d9db85b9dee039cb51dfab967b46a502d/family/README.md) makes the authority boundary explicit: accepted final `out/rig`, `out/parts`, `parts.json`, and `out/check/build` files are the current inputs. `config.json` and upgrade scripts also contain unadopted experiments. A blanket rebuild from them is not a source-preserving way to inspect the accepted artifact.

## File inventory and actual fields

All specimen paths below are relative to [family/naru](https://github.com/rig-c/parts-examples/tree/4991957d9db85b9dee039cb51dfab967b46a502d/family/naru).

| File | Fields / actual specimen | What the reviewer can derive |
| --- | --- | --- |
| `inputs/painting.png`, `painting_rgba.png` | Original character crop, distinguished RGB/background and alpha-bearing source | Source comparison; hidden synthesized pixels are not recoverable ground truth |
| [`inputs/layers/head/layers.json`](https://github.com/rig-c/parts-examples/blob/4991957d9db85b9dee039cb51dfab967b46a502d/family/naru/inputs/layers/head/layers.json), corresponding full/head_orig/full_orig sets | Root `width`, `height`, `layers`; rows `name`, `filename`, `left`, `top`, `right`, `bottom`, `depth_median`, `depth_filename` | Layer-space boxes and extraction provenance. Current cropped `parts/<tag>.png` paths must be resolved from the actual public layout, not blindly from historical wrapper filenames |
| [`config.json`](https://github.com/rig-c/parts-examples/blob/4991957d9db85b9dee039cb51dfab967b46a502d/family/naru/config.json) | `seethrough.head_box`, `assemble.rig_scale`, `assemble.plan`, bones/chains, meshes/contour regions, constraints, motion | Recipe semantics and historical intent. Not authoritative replacement for final repaired geometry |
| [`out/parts.json`](https://github.com/rig-c/parts-examples/blob/4991957d9db85b9dee039cb51dfab967b46a502d/family/naru/out/parts.json) | `rig_size:[800,2284]`, `scale_rig_per_source:1`, 20 `parts`; row `name,from,x,y,w,h,opaque_px`, projection counters and optional visibility counters; root `recomposite` | Named part placement, crop bounds, source/generated origin and stored recomposition diagnostics |
| `out/parts/<name>.png` | Cropped assembled art | Part alpha/contour and source-aligned comparison, distinct from padded rig textures |
| [`out/rig/rig.json`](https://github.com/rig-c/parts-examples/blob/4991957d9db85b9dee039cb51dfab967b46a502d/family/naru/out/rig/rig.json) | `spec`, `skeleton`, `bones`, `slots`, `skins`, `constraints`, `stops`, `invariants`; 69 authored bones, 20 slots. Weighted attachments have `type:"mesh"`, `image`, `width`, `height`, `uvs`, `triangles`, `hull`, `weights` | Authoring identities and exact named per-vertex bone influences; this is not the compiled model schema |
| [`out/rig/motion.json`](https://github.com/rig-c/parts-examples/blob/4991957d9db85b9dee039cb51dfab967b46a502d/family/naru/out/rig/motion.json) | Authoring animation input; compiled result exposes `idle` | A frozen inspection pose can be identified by the actual animation/time. No authoring through review |
| `out/rig/images/<name>.png` | Padded textures; topwear is 501×434 rather than its 493×426 part crop | Padding must be included when mapping image/UV/part coordinates |
| [`out/rig/mesh_report.json`](https://github.com/rig-c/parts-examples/blob/4991957d9db85b9dee039cb51dfab967b46a502d/family/naru/out/rig/mesh_report.json) | Array of 5 mesh reports; `part,vertices,triangles,hull,bones,max_influences,mean_influences,art_coverage,mode,params,contour,regions` | Stored generation diagnostics and region reach. Counts/coverage are report claims, not fresh measurements by review |
| `out/rig/*.provenance.json`, `outline.policy.json` | Repair-specific operations and source/target records; provenance shapes vary | Explain geometry/image changes and preserved fields. Do not force every file into one invented provenance schema |
| [`out/check/build/skeleton.model.json`](https://github.com/rig-c/parts-examples/blob/4991957d9db85b9dee039cb51dfab967b46a502d/family/naru/out/check/build/skeleton.model.json) | `spec:"rigc-compiled/3"`; `stage,bones,slots,skins,animations,images,pages,meshes,physics,...`; 105 compiled bones, 20 slots, `idle` only | Actual published-player input. Generated control bones explain why authored/compiled bone totals differ |
| `out/check/build/skeleton.json`, `.atlas`, `.png` | Spine export and packed atlas alongside the compiled model | Export inspection only with appropriate reader; not an excuse to parse Spine in the frontend |
| [`out/check/check.json`](https://github.com/rig-c/parts-examples/blob/4991957d9db85b9dee039cb51dfab967b46a502d/family/naru/out/check/check.json) | Stored named check results, `rigc_entry`, sampling/physics scope | Show the check's actual scope and binding; a saved PASS is not current runtime/visual proof |
| [`out/check/idle_frames/frames.json`](https://github.com/rig-c/parts-examples/blob/4991957d9db85b9dee039cb51dfab967b46a502d/family/naru/out/check/idle_frames/frames.json), [`out/check/idle_frames/idle/geometry.json`](https://github.com/rig-c/parts-examples/blob/4991957d9db85b9dee039cb51dfab967b46a502d/family/naru/out/check/idle_frames/idle/geometry.json) | `rigc-frames/1`, measured `viewport`; set `animation:"idle",fps:12,sampled:41,written:41,stride:1,duration:3.333…` | Reproduce this stored render's camera/sample context. Its render rate does not establish a different input video's or pose sequence's clock |

The public [`PartRecord` contract](https://github.com/rig-c/parts/blob/a16b322a54fd1fb7f5db69745f9995590580fd86/src/parts.ts) additionally defines optional `cut_from`, `limb`, and cap records. A limb may carry `name`, `segment`, `of`, `bone`, `joint`, and `range`; a cap records its cut location/box/coverage. The selected specimen's 20 records do not expose those limb records. Do not display inferred cut lines as measured data.

## Coordinates and schema joins

The coordinate contracts are documented in public [assemble.ts](https://github.com/rig-c/parts/blob/a16b322a54fd1fb7f5db69745f9995590580fd86/src/assemble.ts), [rig.ts](https://github.com/rig-c/parts/blob/a16b322a54fd1fb7f5db69745f9995590580fd86/src/rig.ts), [coords.ts](https://github.com/rig-c/parts/blob/a16b322a54fd1fb7f5db69745f9995590580fd86/src/coords.ts), and [AUTHORING](https://github.com/rig-c/parts/blob/a16b322a54fd1fb7f5db69745f9995590580fd86/docs/AUTHORING.md). A UI must name the space next to the values.

| Space | Specimen example | Required mapping |
| --- | --- | --- |
| See-through layer canvas | Head layers are 1024×1024; face bounds `[257,197,693,701]` | Head extraction uses source `head_box:[160,300,600,740]`. Crop, resizing and full-run square padding must be applied before comparison with source/rig pixels. Layer box coordinates are not rig coordinates |
| Assembled rig crop | `parts.json` face `x:271,y:385,w:187,h:217`; topwear `154,599,493,426`; origin top-left, x right, y down | Part pixel `(i,j)` lies at `(x+i,y+j)` in rig crop. `rig_scale` and source extraction transforms remain explicit |
| Padded rig image | Topwear 501×434 | The documented 4-pixel border on every edge accounts for the +8 dimensions. Part alpha and padded texture alpha use different local origins |
| Skeleton world | `skeleton/stage:{x:-400,y:0,width:800,height:2284}`; root at crop bottom-center | For this unrotated 800×2284 crop at scale 1, crop `(x,y)` maps to world `(x-400,2284-y)`. Bone-local coordinates require the actual inverse bone transform, especially for rotated ancestors; use producer/runtime transforms rather than a second frontend conversion |
| Authored weighted vertex | `weights[0]` has named `chest` and `hip` bindings with separate bone-local x/y and weights | A vertex does not have one shared local x/y. Obtain posed world vertices through the actual poser. Never mistake a binding's x/y for crop coordinates |
| Compiled mesh/atlas | `skins[].attachments[slot][attachment]` uses `kind:"mesh"`, `vertices:{weighted:true,bindings:[...]}`; atlas region mapping is in `pages[].regions` | Respect compiled schema and atlas rotation/offset metadata. Do not reuse authoring `weights` or raw UVs as screen coordinates |

Feature examples in rig crop: `iris_r` `(316,508,26,25)`, `iris_l` `(395,485,28,26)`, `nose` `(357,529,14,23)`, `mouth` `(362,556,42,19)`. These are part rectangles, not proof that every feature's opaque pixel is contained inside face alpha. That inspection needs decoded alpha masks at one correctly aligned source/pose state.

Some layer rows have a 1×1 placeholder box. Some repaired part rows omit the entire optional `visible_px/occluded_px/visible_not_projected_px` trio. Missing is unavailable, not zero. `hair_back.from:"head:author:generated-backhair"` records generated hidden repair, not source-backed hidden pixels. The [body-edge repair record](https://github.com/rig-c/parts-examples/blob/4991957d9db85b9dee039cb51dfab967b46a502d/family/naru/repairs/BODY_EDGE_RESTORATION.md) explains why historical projection counters cannot certify subsequent repaired pixels.

### Concrete topwear mesh and chest region data

The final authoring attachment and compiled summary agree on **527 vertices / 964 triangles**. Authoring `uvs` has 1054 numbers, `triangles` 2892 indices, `hull` 88, and `weights` 527 vertex entries. Influencing bones are actual named `chest`, `hip`, `boob_r`, `boob_l`; the mesh report states maximum 3 influences and mean 2.59. The compiled attachment stores these bindings in its own schema.

The recipe's contour regions illustrate **chest deformation region** controls: `bust_r` center `(287,826)`, radius `21`, band `83`, bone `boob_r`; `bust_l` center `(501,827)`, radius `21`, band `85`, bone `boob_l`. They are crop-space authored deformation regions. They are not anatomical measurements, nor a guaranteed reconstruction of later repaired final weights. The current mesh report separately records region reach: right `reached:190,whole:10`; left `reached:200,whole:9`. Region inspection must distinguish recipe circle, final topology, and actual final influence.

The [region repair record](https://github.com/rig-c/parts-examples/blob/4991957d9db85b9dee039cb51dfab967b46a502d/family/MESH_REGION_REPAIR.md) explicitly distinguishes screen-side naming and documents quantized sampled boundaries. A correction proposal should name the actual region/bone and coordinate space; moving the garment artwork is a different action from changing a deformation region or a joint pivot. None is implemented by this reading.

### Atlas pages are not parts

This compiled artifact has **one packed page**, `skeleton.png` at 712×2031 with 20 regions. Topwear's region is `(209,2,501,434)` and face's is `(373,1235,195,225)`. `images[]` also lists unpacked source textures such as `../../rig/images/hair_back.png`. Those records are not 20 playback pages.

The parts pane therefore needs a join: selected slot → current skin attachment → actual atlas region/page, plus separately declared source image/provenance. It must not assume “one page per part”, use an unpacked provenance path as the playback atlas, or bypass review's contained asset-path rules. A future public review package must stage declared contained files without editing the upstream specimen.

## Manual inspection needs and the data that settles them

The issue establishes the requested inspection list; the linked public records give concrete examples without claiming access to private manual sessions.

| Inspection | Data needed / what to show | Public evidence and present limitation |
| --- | --- | --- |
| Feature bounds against face alpha | Named feature part/attachment; face and feature alpha masks; crop/extraction transforms; same held pose/camera | `parts.json` and head layer boxes exist. Bounding-box overlap alone cannot detect an eye/mouth leaving face alpha |
| Mesh folds and unnatural deformation | Actual posed triangle vertices; stable vertex/triangle IDs; signed area/degeneracy; texture/source overlay; explicit animation/time/axis/environment and sampling scope | [Repair case study](https://github.com/rig-c/parts-examples/blob/4991957d9db85b9dee039cb51dfab967b46a502d/family/REPAIR_CASE_STUDY.md) documents cuffs inverting under wind. Stored no-fold checks exclude physics; visual naturalness is an owner judgment, separate from a geometric fold metric |
| Contour and named weights, including chest deformation region | Source alpha outline, final mesh hull/interior edges, per-vertex bone weights, optional recipe region circle/polygon and falloff | [Region repairs](https://github.com/rig-c/parts-examples/blob/4991957d9db85b9dee039cb51dfab967b46a502d/family/MESH_REGION_REPAIR.md) show real weights/topology matter even when named bones exist. A density slider preview is not a completed retopology/weight repair |
| Limb cut lines / caps | Explicit `cut_from`, limb segment/joint/range and cap boxes/masks, source crop, resulting slot order | Supported in public `parts.ts`/AUTHORING; absent from chosen records. Refuse a measured-cut overlay for this specimen instead of inferring anatomy from filenames |
| Drawn angle and set coverage | Actual alternate drawings, named set/attachment mapping, producer-declared angle controls and coverage, same deformation pose for original/result | [Public root README](https://github.com/rig-c/parts-examples/blob/4991957d9db85b9dee039cb51dfab967b46a502d/README.md) says three-quarter input paintings are inputs only, not consumed builds. Outfit directories are not proof of angle coverage |
| Per-part atlas/content fidelity | Part source, padded texture, actual packed region, region dimensions/rotation/offset and pixel comparison at explicit mappings | Current model packs 20 regions onto one page. [Body-edge restoration](https://github.com/rig-c/parts-examples/blob/4991957d9db85b9dee039cb51dfab967b46a502d/family/naru/repairs/BODY_EDGE_RESTORATION.md) distinguishes damaged source-supported edges from generated hidden repair |
| Disconnected islands and outline coverage | Actual island slots/attachments and original triangle field; per-piece alpha coverage and binding continuity | [Outline-field-islands](https://github.com/rig-c/parts-examples/blob/4991957d9db85b9dee039cb51dfab967b46a502d/family/tools/outline-field-islands/README.md) is explicitly historical intermediate work. It preserves triangle fields; it is not automatically a fold repair or final accepted model |

### Face and torso angle inspection is a deformation inspection

The owner's requirement is to judge whether **face horizontal/vertical and torso horizontal angle changes deform the mesh naturally**, then retain that exact pose while inspecting and giving feedback. It is not a camera spin. Useful controls are named producer axes with declared valid ranges, explicit original/modified or source/rig comparison, and contact-sheet presets evaluated at actual supported values. Combined-axis poses need a declared composition contract; one scalar animation cannot establish compound coverage.

Public parts AUTHORING describes `turn` inputs (`pivot`, `depths`, optional `deform`, `band`, `radius`, surface/head options) and alternate-drawing coverage. Those are producer authoring contracts. They are not capabilities discovered in this selected build.

Here, the compiled model has `idle` only, `rig.axisBone:null`, `axisSubtree:[]`, and no declared face-yaw/face-pitch/torso inspection controls. The authoring `invariants.axes` entry named `face` through `eye_r/eye_l` is an alignment invariant, not a viewing-angle axis. Do not manufacture degree ranges, map `idle` onto yaw, treat a rotated source painting as generated angle coverage, or enable unconnected angle sliders.

A future package with real angle support must supply the named runtime mapping, valid range, neutral value, affected parts, any actual set/drawing identity, and a declared composition rule if multiple controls combine. Its acceptance must include actual posed geometry and paired source/result images at the supported samples. The present specimen can establish the unavailable state honestly; it cannot validate that feature.

## Proposed first slice: inspect one actual mesh at a frozen pose

**One end-to-end slice:** select `topwear`, hold the real `idle` pose at a specified time, inspect source alpha + actual posed mesh + named weights, and export one structured feedback item with enough context to reproduce it. This uses existing actual data rather than inventing face/body axes. Face/torso deformation inspection remains a required next capability once an appropriate public build provides real axes.

UI behavior:

1. Select the actual `topwear` slot/attachment from the part list; show the immutable model/source identity and the distinction between assembled crop, padded texture and packed page.
2. Freeze the published runtime at named animation/time with explicit deterministic seek/environment policy. Show one shared camera for texture, triangle/alpha overlays, and optional isolated part. A source-image view must show its own explicit coordinate alignment.
3. Select a triangle/vertex and display actual named bone weights and posed position, keeping source bone-local bindings labeled. Outline/weight toggles change inspection only; no drag, density change, retopology or source writes.
4. Record actual slot target, defect/quality chosen by the reviewer, one-line summary, selected inclusive frame interval where its clock is known, plus separate held time/camera/part/geometry identifiers in context. No frame-rate inference. Export with existing rig/motion hashes and package/runtime/viewer identity; source bytes remain unchanged.
5. Show face/torso angles as unavailable because no mapping exists, with the required input named. Do not make this first slice's success stand in for angle-deformation acceptance.

Acceptance bar for a later implementation:

- Fixture-derived mesh counts and identities match actual loaded geometry; topwear resolves to 527 vertices / 964 triangles and the correct packed region, not the stored older check's 551-triangle entry.
- At least one real posed triangle and its weights are independently compared with the published poser. A malformed/out-of-range triangle index and unknown binding bone are refused by name; missing optional authoring data is displayed as unavailable.
- Camera/zoom changes preserve selected part, held time and geometry; toggling mesh/weight/source inspection cannot advance animation or alter the model.
- Known source/padded texture landmarks and alpha edges align under the stated transform. This needs genuine rendered/geometry evidence and a browser acceptance run when authorized; a source read or typecheck cannot prove it.
- A feedback round trip retains the actual target and selected interval separately from playhead context, binds the input hashes, and leaves all source hashes unchanged. No pass/approval is created merely by opening the view.
- Visual naturalness remains an explicit owner review. A zero fold count certifies only its named sampled geometry/environment domain.

Rejected first-slice expansion: mesh-density changes and contour/weight authoring. They change topology/binding/deform relationships and require a source patch, undo, regeneration and conflict contract. The data above can support inspecting their output, but #15 requests a reading and one inspection, not an editor implementation.

## Verification and evidence limits

Read-only checks performed: `gh issue view 15`, `gh api` pinned public source/docs/JSON; parsed actual JSON structures and counted arrays; SHA-256 and byte-length comparisons of the six public response byte streams below against pinned [`family/accepted-inputs.json`](https://github.com/rig-c/parts-examples/blob/4991957d9db85b9dee039cb51dfab967b46a502d/family/accepted-inputs.json). All six match the inventory. No private input, browser, image capture, rebuild, runtime pose measurement or pixel/visual acceptance was used.

| Relative to `family/` | Bytes | SHA-256 verified against inventory |
| --- | ---: | --- |
| `naru/out/parts.json` | 12319 | `ea67083184cce1f5cdc63bb652ddd76f6f6f097851b61e1f79b8cfb65da8c99e` |
| `naru/out/rig/rig.json` | 707603 | `222d5f574cdf0046e5a3bf0c83e30154aaf2b82cb54efa0bd5fc3f90e066a504` |
| `naru/out/rig/motion.json` | 49516 | `030708e65da20a848878a988c324c3ba9061a68333cfba05d5fc71bd03364f76` |
| `naru/out/rig/mesh_report.json` | 6315 | `d8953fda48dc6e207824c851e83ad574030d55c559212770e3d4a150f5d8c40d` |
| `naru/out/check/check.json` | 7909 | `9b03a54bac38094b61a383ea0340c1379866ef06530c99a11f7e139652ceed7a` |
| `naru/out/check/build/skeleton.model.json` | 985946 | `fa35ea4e17ec79f30cbed761412fca74f632a86806f856cc70af0c8edf11f529` |

Important cross-file observation: the accepted stored `check.json` reports `TEXTURE_STRETCH.per_mesh[topwear].triangles:551`; the accepted authoring/compiled artifact and mesh report contain 964. Hash inventory membership proves these bytes were accepted together; it does not prove the check was measured on that topology. Therefore display that report as stored scoped evidence and require a direct artifact binding/new measurement before claiming it validates the current mesh. This reading does not diagnose or modify upstream data.

The document proposes a future first slice only. Motion remains read-only. No current review capability or upstream compiler/core contract is changed.
