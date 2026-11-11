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
  `/hub/`, owner, language and capability URLs. Routing does not widen grants or
  change API contracts. See [public stability](STABILITY.md).
- **E3** Record publications are hosted over the existing inspection screen
  (#754). Their checkpoint, signoff, reopen and interview forms open in a dialog.
  A record without a picture does not manufacture a model or package.
- **Remaining:** legacy job-window owner surfaces still exist (#756); hub/owner
  single-entry adoption is planned under F (#734). A shared component requirement
  is not evidence that those migrations have shipped.
- **Compare is preserved:** header Compare remains two-build A/B comparison with
  a reference, enabled when a second build is supplied. Its existing host,
  layouts and controls remain unchanged. Card D is **PARKED**, not planned work.

## 2. Components

### C1 App shell

The existing shell owns the header, language, workspace regions and status line.

- **Shipped:** Setup · Animate · Compare in the header is the sole mode switch
  (#741). The bottom panel selects content, never a second mode.
- The existing workspace places the parts list at left, the toolbars above the
  main view, and the resizable Inspector directly below it. The right region is
  reserved in this workspace; it is not a new context sidebar.
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
- Overlay is a secondary-toolbar control, not another menu group. Do not restore
  the superseded grouped Part/Overlay/Atlas menu.
- Compare keeps its existing **Side by side · Reference · Build A · Build B**
  menu and legacy controls. It is not a Difference mode or an approved migration.

### C6 Bottom panel

- **Shipped:** the main workspace has a resizable bottom panel directly beneath
  the view. Its heading keeps the current mode's content tabs, **Comments (n)**,
  and the act bar at the right of that same row (#741). The row remains reachable
  when the content is collapsed. Height is a saved workspace preference.
- Setup blocks: **Part · Modeling · Chest · Mesh · Weights · Bones · Fields ·
  Cuts · Cloth**, then **Comments (n)**.
- Animate blocks: **Transport · Sound · Environment · Physics · Idle tracks ·
  Readings · Requirements · Retarget · Report**, then **Comments (n)**. The
  timeline remains Animate content, not a second mode selector.
- Parts use that same panel; Part and Comments are usable, while rig-only
  blocks are disabled with the missing-rig reason.
- Reuse `mountRigInspector`, `bindInspectorBlocks` and `mountBottomPanel` in
  `inspector-blocks.ts`. The Comments button/panel retains identity across modes.
- **Historical:** old parts Issues/Producer flags tabs, bottom
  Setup/Animate/Write review mode tabs and the proposed Compare tab replacement
  are superseded. Compare's existing View/Rig/Playback/Feedback sections are retained.

### C7 Side panel (right)

This heading remains for inbound links. The rig/parts workspace has no right
context panel. Use the existing left Checkpoints list and main-view Difference;
record asks use the dialog in C10.

**Historical:** the old parts sidebar, producer flags and mesh-numbers panel
were deleted (#745). Mesh edges is the visual mesh inspection surface. Geometry
numbers remain available to agent readers; the existing rig Mesh precision
instrument is not the removed parts numbers panel.

### C8 Comments

- **MUST** keep comments as the only feedback-input feature (R2), allowing any
  number of general or pointed comments per submission. Preserve source-bound
  capture, pins and crops in `stage-comments.ts` and `parts-comment-crops.ts`.
- **Shipped:** rig feedback lives in Comments with its existing frame range,
  category, typed target, correction request, provenance, downloads and warnings.
  Parts verdicts are comments-based (#751): no issues approves; issues request
  changes. The act remains beside the content row, not inside a separate page.
- **Remaining:** record forms still retain their existing memo inputs. C (#715)
  owns their move to Comments; the legacy job-window owner surfaces are removed
  by #756. Do not claim either cleanup has shipped.
- Preserve historical serialized text and parsing. A UI rule does not authorize
  changing act fields or downstream consumers; see the contract references.

### C9 Survey answer

Survey answers are distinct from feedback comments. Preserve interview choices,
inline Other text and per-question notes through the existing answer contract.

- **Shipped:** #754 hosts the existing record interview answer forms in a dialog
  on the inspection screen. It reuses the current forms rather than replacing
  their answer contract.
- **Planned:** B (#722) is the remaining interview-modal work. Existing
  `interview-panel.ts` is the component to extend; no new interview page, image
  viewport or question renderer is authorized by this document.

### C10 Act bar

- **Shipped:** `mountActBar` places the pending ask, decision/submit and save
  state at the right of the bottom tab row. The act follows the subject, not
  the chosen mode. A tab change never submits it.
- Parts submit the comments-based verdict; rig review retains its decision and
  submit action. Failed saves and drafts remain explicit.
- **Shipped:** record checkpoint, signoff, reopen and interview asks open the
  existing forms in a native dialog over this screen (#754), through the existing
  act button. No-picture records use an explicitly empty inspection workspace.
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
or record dialogs. Do not duplicate visual checkpoint evidence in a sidebar;
inspect supported pixels through the main view. Historical records remain readable.

## 3. Screens

These are subjects and hosts of the existing tool, not designs for new screens.

| Subject or host | State at `22d824f` | View and decision home |
| --- | --- | --- |
| Rig package, including hosted rig | Shipped | Header Setup/Animate; shared rig/reference view; mode blocks + Comments; act bar |
| Parts package, including hosted parts | Shipped (#745, #749, #751) | Same Setup workspace and parts list; original follows selection; comments verdict |
| Two builds and a reference | Shipped, unchanged | Header Compare; existing A/B host and controls; card D PARKED |
| Record checkpoint, signoff, reopen, interview | Shipped hosting (#754) | Existing screen with a dialog; no model fabricated for a record without a picture |
| Remaining interview-modal work | Planned B (#722) | Extend existing interview component |
| Remaining record-modal feedback cleanup | Planned C (#715) | Move existing memo feedback to Comments without changing contracts |
| Legacy job-window owner surfaces | Removal planned (#756) | Existing shared inspection and record-dialog homes |
| Hub and owner workspace | Single-entry adoption planned F (#734) | Existing hosts remain until their migration lands |

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
- F (#734): hub/owner single-entry adoption.
- #756: removal of remaining job-window owner surfaces.
- #743: in-place update when the agent publishes a new result, keeping the
  selection, camera and time, and the act bar's status text after submit.
- #725: a joined Create project opens at its current stage, including an
  interview-stage project with no build yet.

Card D is **PARKED**. Compare remains A/B with a reference. Difference is already
shipped in Setup; neither a Compare-to-diff conversion nor a Compare migration
is planned. UI follow-ups still need the owner's layout and working-screen
rulings. Public-contract changes still require the existing HQ approval boundary.
