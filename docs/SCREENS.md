# Screen specification: components and screens

Review extends the existing rig inspection workspace to accept parts and agent
asks. It does not build another review tool or a screen per publication kind.
This document applies the [core UI rules](DESIGN.md#core-ui-rules-owner-2026-11-11)
to that workspace. [PANELS.md](PANELS.md) and [PARTS_VIEW.md](PARTS_VIEW.md)
remain panel and data references; their historical layouts do not restore removed UI.

**Shipped** below means present in main `22d824f`, not a new runtime or visual
acceptance claim. **Planned** identifies remaining work explicitly listed in §4.
**MUST** states the shared-component requirement, not proof every legacy host
already meets it. Extend existing modules; do not create sibling implementations.
The owner rules on layout before a UI change and on its working screen before
merge (R0). This documentation update adds no UI or public contract.

## 1. Entry and routing

- **E1** `web/index.html` is the shared inspection entry. Parts packages use it
  through `setupEntryHtml` and `web/main.ts`; the old `/parts.html` URL redirects
  to the same entry (#745). Rig and parts do not have separate review pages.
- **E2** Preserve public rig/compare, `/instances/<key>/…`, `/jobs/<jobId>/`,
  owner, language and capability URLs. Routing does not widen grants or
  change API contracts. See [public stability](STABILITY.md).
- **E3** Record publications are hosted over the existing inspection screen
  (#754), with Comments in the right communication panel (#1041) and
  **Send comments** in `#workspace-act-row` (#1239, #1247). Until 5.0.0, record
  checkpoint, signoff and interview answer forms also sat in the right
  communication panel (removed in #1246, #1251 and #1252).
  A record without a picture does not manufacture a model or package.
- **Shipped:** #756 and hub/owner single-entry adoption F (#734) shipped in
  [2.13.0](../CHANGELOG.md#2130). The remaining job window and hub were removed in
  [4.0.0](../CHANGELOG.md#400).
- **Compare is preserved:** header Compare remains two-build A/B comparison with
  a reference, enabled when a second build is supplied.
  - Its header moved onto the shared owner shell in #655 slice 4.
  - Its host and bundle move behind the single entry in #655 S5–S7 with no
    visible change (0 differing pixels, EN/KO, standalone and owner frame).
  - Its layout and controls stay unchanged until S8 (status bar, header,
    toolbars and view controls, inspector, parts explorer on the shared
    components) is ruled. S8 waits until the rework's steps have all run once.
  - Card D is **PARKED**, not planned work.

## 2. Components

### C1 App shell

The existing shell owns the header, language, workspace regions and status line.

- **Shipped:** Setup · Animate · Compare in the header is the sole mode switch
  (#741). The bottom panel selects content, never a second mode.
- The existing workspace places the parts list at left, the toolbars above the
  main view, the resizable Inspector directly below it, and the communication
  panel at the right (#1041). The bottom panel holds the controllers tied to the
  view; the right panel holds communication with the AI. Place any new element
  by this rule.
- Reuse `workspace-ui.ts`, `workspace-layout.ts` and `workspace-preferences.ts`
  for shell composition, resizing, drawers and browser preferences. Embedded
  inspection retains the existing header-hiding behavior.
- Changing a mode or content tab does not apply, approve or submit anything.

#### C1a Stage navigation

**Historical, superseded by #741:** numbered step chips and `stage-nav.ts` were
removed. This heading remains for inbound links. Pipeline stages are internal;
never reconstruct their navigation. The current pending ask is text beside the
act bar, not another mode switch.

### C2 Navigator (left panel)

- **Shipped:** `PartExplorer` is the parts/slots list for compiled rigs and parts
  subjects. Reuse its search, thumbnails, selection, Whole rig, Solo and
  subject-supported visibility controls.
- The existing left Checkpoints list, Reference picker and Settings keep their
  homes. Do not move them to a new list or toolbar to satisfy the superseded plan.
- With an original painting supplied, the parts Reference pane follows the
  selected part (#749). This is a crop of the bound original, not a guessed asset.
- Hub/owner navigation and interview questions retain their current hosts until
  the named work in §4 lands; they are not additional shipped parts-list variants.

### C3 Main toolbar

- **Shipped:** the shared rig/parts workspace separates the main and secondary
  toolbars. The main row holds Comment, camera sync and the common view controls.
- **MUST** reuse the existing control constructors and order in C5b. Do not
  duplicate a toolbar for a different subject.

### C4 Secondary toolbar

- **Shipped:** layers and subject tools occupy the separate secondary row.
  Parts reuse Images and Mesh edges, with Overlay and Part opacity beside them.
  Mesh edges includes the uncovered-art tint; per-part visibility lives in C2.
- Unavailable tools remain disabled with a named reason. Parts have no compiled
  rig, so bone tools and rig-only instruments do not pretend to work.
- The existing rig precision instruments still send data to the installed
  producer for scratch rebuilds; this screen specification adds no operations.

### C5 Main view

- **Shipped:** rig and parts share `viewport-pair.ts`, `viewport-controller.ts`
  and their existing providers. Parts show assembled images on this same screen;
  selecting and isolating a part uses the existing list and viewport.
- Shared modules own zoom at the pointer, pan, Fit, 1:1, resize and camera replay.
  Parts' native image scale remains distinct from compiled-rig Fit-relative scale.
- Setup Difference inspects original versus subject pixels in the main view.
  It does not create a sidebar evidence panel or grant compiler acceptance.
- Compare retains reference/A/B inspection and its existing camera/layout path;
  the parked card D does not authorize replacing it.

#### C5b View control set

- **MUST** reuse the control order **Zoom in → Zoom out → Fit → 1:1 → View switch**,
  followed by the zoom value, through the shared implementation (R3a/R4).
- **Shipped:** `inspectionViewSwitch` is the single rig/parts menu definition:
  **Side by side · Reference · Rig · Difference**. The first three names, order
  and placement stay unchanged. Difference is the fourth item, available in
  **Setup**, shipped for parts (#745) and rig (#752).
- Difference stays visible but disabled by name without a usable original
  reference. Parts additionally require the declared rig-space painting operand;
  rig Difference requires a loaded painting aligned to the declared native canvas.
  Rig Difference outside Setup names `RIG_DIFFERENCE_SETUP_ONLY`.
- **Shipped (#957):** when a publication binds a previous draft, parts
  Difference can also compare with that draft.
- Overlay is a secondary-toolbar control, not another menu group. Do not restore
  the superseded grouped Part/Overlay/Atlas menu.
- Compare keeps its existing **Side by side · Reference · Build A · Build B**
  menu and legacy controls. It is not a Difference mode or an approved migration.

### C6 Bottom panel

- **Shipped:** the main workspace has a resizable bottom panel directly beneath
  the view. Its heading keeps the current mode's content tabs (#741); the
  duplicate bottom **Comments (n)** tab was removed in favour of the top
  **Comment · C** entry (#835), which now opens the communication panel at
  Comments and starts pin mode (C7, #1041), and act controls moved from the bottom row to
  `#workspace-act-row` beneath the top bar as their single home (#845, #1040). The row remains reachable when
  the content is collapsed. Height is a saved workspace preference.
- Setup blocks: **Part · Modeling · Chest · Mesh · Weights · Bones · Fields ·
  Cuts · Cloth**.
- Animate blocks: **Transport · Sound · Environment · Physics · Idle tracks ·
  Readings · Requirements · Retarget · Report**. The timeline remains Animate
  content, not a second mode selector.
- Parts use that same panel; Part is usable, while rig-only blocks are disabled
  with the missing-rig reason. With no controller block left, the panel collapses
  to nothing and the main view takes the height (#1041).
- Reuse `mountRigInspector`, `bindInspectorBlocks` and `mountBottomPanel` in
  `inspector-blocks.ts`. On the single review page the bottom rows carry no
  Comments or Question selection; both live in the communication panel (C7).
- **Historical:** old parts Issues/Producer flags tabs, bottom
  Setup/Animate/Write review mode tabs, the visible bottom **Comments (n)** tab
  (#741, removed by #835) and the proposed Compare tab replacement are
  superseded. Compare's existing View/Rig/Playback/Feedback sections are retained.

### C7 Side panel (right)

- **Shipped (#1041):** the communication panel holds communication with the AI:
  the pending question on top and Comments below, each under a one-line heading,
  with the comment rows above the provenance block. It is single-column by
  container query and has its own saved width (`communicationWidth`).
- It is collapsed while nothing is pending; **Comment · C** and a pending ask open
  it without changing the bottom panel. Below the stage minimum it is a
  right-side drawer, non-modal for a question.
- **Historical (until 5.0.0):** record asks (checkpoint, signoff, plan approval)
  sat in their own section between the question and Comments (#1041), opened by
  the act row's **Review…** or **Approve…** buttons (signoff and **Approve…**
  removed in #1246, interview answer forms in #1251, checkpoint Pass/Fail in
  #1252). Comments and **Send comments** remain the live feedback surface
  (#1247, #1314).
- Use the existing left Checkpoints list and main-view Difference for inspection.

**Historical:** the old parts sidebar, producer flags and mesh-numbers panel
were deleted (#745). Mesh edges is the visual mesh inspection surface. Geometry
numbers remain available to agent readers; the existing rig Mesh precision
instrument is not the removed parts numbers panel.

### C8 Comments

- **MUST** keep comments as the only feedback-input feature (R2), allowing any
  number of general or pointed comments per submission. Preserve source-bound
  capture, pins and crops in `stage-comments.ts` and `parts-comment-crops.ts`.
- **Shipped:** rig feedback lives in Comments with its pinned-comment frame range,
  category, typed target (#1257), correction request, provenance, downloads and warnings,
  and **Send comments** in `#workspace-act-row` sends live `rig-review/act@10`
  comments or saves standalone local sends (#1239, #1314). Until 5.0.0 (#1314,
  #1321), parts submitted a comments-based verdict (#751: no issues approved;
  issues requested changes). The act row remains above the workspace, not inside
  a separate page.
- **Remaining:** record forms still retain their existing memo inputs. C (#715)
  owns their move to Comments; the legacy job-window owner surfaces are removed
  by #756. Do not claim either cleanup has shipped.
- Preserve historical serialized text and parsing. A UI rule does not authorize
  changing act fields or downstream consumers; see the contract references.

### C9 Survey answer

Survey answers are distinct from feedback comments. Preserve interview choices,
inline Other text and per-question notes through the existing answer contract.

- **Shipped:** #754 hosts the existing record interview answer forms on the
  inspection screen, in the right communication panel since #1041. It reuses the current forms rather than replacing
  their answer contract.
- **Planned:** B (#722) is the remaining interview-modal work. Existing
  `interview-panel.ts` is the component to extend; no new interview page, image
  viewport or question renderer is authorized by this document.

### C10 Act bar

- **Shipped:** `mountActBar` places the headline, **Send comments** control and
  save state in the shared `#workspace-act-row` directly beneath the top bar as
  their single home (#845, #1040, #1239, #1314, superseding the #741 bottom-row
  placement; the row hides when early refusal or closed state suppresses it). The
  act row follows the subject, not the chosen mode. A tab change never submits it.
- **Send comments** submits unsent comments (and pending Edit Mesh or chest
  landmark carriers on a live model publication, #1243) as `rig-review/act@10`
  in a live job (#1239, #1247) or saves `rig-review/local-comments@1` on a
  standalone package or parts folder (#1314). Until 5.0.0 (#1314, #1321), parts
  submitted a comments-based verdict and rig review retained a verdict decision
  and submit action. Failed saves and drafts remain explicit.
- **Historical (until 5.0.0):** record checkpoint, signoff and interview asks
  opened forms in the right communication panel (#754, #1041; removed in #1246,
  #1251 and #1252). Records still use the shared inspection screen — including
  an explicitly empty workspace when no picture is supplied — and send comments
  from `#workspace-act-row` (#1247).
- **Planned:** C (#715) completes record-modal feedback cleanup; #756 removes
  the remaining job-window owner surfaces. Hosting a form on this screen is not
  proof those follow-ups are complete.
- Act kinds, authority, source binding, replay and recorded text remain defined
  by [the live job contract](REVIEW_PACKAGE.md#live-job-contract) and
  [public stability](STABILITY.md). This document changes none of them.

### C11 Status bar

Reuse `mountStatusBar` for the existing message, readouts, draft/save state and
source hash. Status is not another feedback input or approval action.

### C12 Timeline and transport

Animate retains its existing transport and timeline. Time navigation does not
write motion; typed keyed edits go through the installed producer's scratch
build path. Compare retains its existing playback controls.

### C13 Read-only context blocks

Keep source binding, provenance, warnings and plan text in their existing blocks
or the record section of the communication panel. Do not duplicate visual checkpoint evidence in a sidebar;
inspect supported pixels through the main view. Historical records remain readable.

## 3. Screens

These are subjects and hosts of the existing tool, not designs for new screens.

| Subject or host | State at `22d824f` | View and decision home |
| --- | --- | --- |
| Rig package, including hosted rig | Shipped | Header Setup/Animate; shared rig/reference view; mode blocks + Comments; act bar |
| Parts package, including hosted parts | Shipped (#745, #749; comment-only #1314, #1321, superseding #751 comments verdict) | Same Setup workspace and parts list; original follows selection; **Send comments** in act row |
| Two builds and a reference | Shipped, unchanged | Header Compare; existing A/B host and controls; card D PARKED |
| Record publications (plan, option-set, checkpoint evidence) | Shipped hosting (#754; checkpoint, signoff and interview forms removed before 5.0.0 in #1246, #1251, #1252) | Existing screen with Comments in the right panel and **Send comments** in the act row; no model fabricated for a record without a picture |
| Remaining interview-modal work | Planned B (#722) | Extend existing interview component |
| Remaining record-modal feedback cleanup | Planned C (#715) | Move existing memo feedback to Comments without changing contracts |
| Legacy job-window owner surfaces | #756 shipped in [2.13.0](../CHANGELOG.md#2130); remainder removed in [4.0.0](../CHANGELOG.md#400) | Existing shared inspection and record-dialog homes |
| Hub and owner workspace | F (#734) shipped in [2.13.0](../CHANGELOG.md#2130); hub removed in [4.0.0](../CHANGELOG.md#400) | Owner workspace remains on the single entry |

## 4. Migration order

**Historical:** the former seven-step migration list and its blanket STOP on
steps 2–7 are superseded. It must not be used to rebuild deleted parts or stage
UI, or to unpark Compare. The numeric references in the existing copy ratchet
are historical tracking identifiers, not new screen instructions.

Shipped foundations are #741 (header mode and bottom row), #745 (parts on the
shared screen), #749 (selection-following reference), #751 (comments verdict),
#752 (rig Setup Difference) and #754 (record-dialog hosting).

Only the following work remains planned here; this list establishes no new order
or ownership beyond the existing cards:

- B (#722): remaining interview-modal work.
- C (#715): remaining record-modal work, including memo feedback to Comments.
- #743: in-place update when the agent publishes a new result, keeping the
  selection, camera and time, and the act bar's status text after submit.
- #725: a joined Create project opens at its current stage, including an
  interview-stage project with no build yet.

F (#734): hub/owner single-entry adoption shipped in [2.13.0](../CHANGELOG.md#2130); hub removed in [4.0.0](../CHANGELOG.md#400).
#756: shipped in [2.13.0](../CHANGELOG.md#2130); remaining job window removed in [4.0.0](../CHANGELOG.md#400).

Card D is **PARKED**. Compare remains A/B with a reference. Difference is already
shipped in Setup; neither a Compare-to-diff conversion nor a Compare migration
is planned. UI follow-ups still need the owner's layout and working-screen
rulings. Public-contract changes still require the existing HQ approval boundary.
