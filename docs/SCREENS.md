# Screen specification: components and screens

This is the target specification for every Review screen. It applies the core UI
rules in [DESIGN.md](DESIGN.md#core-ui-rules-owner-2026-11-11) (R0–R5) to
concrete components. [PANELS.md](PANELS.md) and [PARTS_VIEW.md](PARTS_VIEW.md)
describe the current panels. Where they differ from this file, this file is the
target, and the difference is migration work tracked in #655.

Each screen is written as a composition of shared components. A screen supplies
configuration and data. It does not build its own copy of a component. Where a
screen needs behavior a component lacks, extend the component for every screen.

- **MUST** is a requirement.
- *Today* lines record the current state on main `a5419f9` and the copies to remove.
- **Owner ruling** marks a choice the owner has not made yet. The layout ruling
  (R0) settles each of these before implementation.

## 1. Entry and routing

- **E1** `web/index.html` is the only web entry. Every screen in §3 mounts inside
  it through the app shell (C1). No screen adds an HTML page or a per-screen
  server route for its markup (R5).
- **E2** These public URLs keep working, as routes or redirects into the single
  entry: `/` and `/instances/<key>/…` (rig and compare),
  `/jobs/<jobId>/` (`lang`, `hub`), `/hub/` (`workspace`, `lang`), the owner
  workspace root, `?lang=en|ko`, and `#cap=` / `#review=` in the hash. Capability
  handling and the API routes stay as they are. The single entry changes markup
  delivery, not API contracts.
- **E3** The screen to mount is chosen from the route and the session payload,
  not from which HTML file was served.
- *Today*: five HTML entries (`index`, `compare`, `parts`, `job-hub`,
  `owner-workspace`) plus an inline job document written by `src/job-front.ts`.
  `src/compare-html.ts` splices nine `<!-- shared:… -->` regions of `index.html`
  into `compare.html`.

## 2. Components

### C1 App shell

Owns the page frame: header, language, status line, stage navigation, and the
workspace layout that places C2–C7.

- **MUST** render one header layout on every screen: product mark, screen title,
  the screen's mode switch if it has one (rig: **Setup · Animate · Compare**),
  stage navigation (C1a), and the language select.
- **MUST** own the language select. A screen never builds its own.
- **MUST** own the workspace layout. Its regions are left (C2), main (C5) with
  the toolbars (C3, C4) above it, bottom (C6), right (C7) and status (C11). Every
  separator is resizable. When the window is too narrow or short, regions fold
  into drawers. Region sizes persist per screen kind.
- **MUST** hide the header when embedded (`stageEmbed`, hub or owner iframe), and
  keep the rest of the layout.
- Props: `screen`, `title`, `modes?`, `stages?`, `regions` (which of C2–C7 are
  present). Events: `mode-change`, `stage-change`, `lang-change`.
- *Today*: `workspace-ui.ts` (separators, drawers, Settings) serves rig and
  compare only. Parts, interview, job, hub and owner each build their own header
  and language select.

#### C1a Stage navigation

- **MUST** show the pipeline stages (**1 Parts + mesh · 2 Interview · 3 Rig +
  animation · 4 Direction**) with the current stage marked, on every screen that
  belongs to a project stage, including job screens.
- **MUST** open a mode of the one screen from each chip, or name the chip
  unavailable: 1 → Setup, 2 → the interview modal, 3 → Animate, 4 → not
  available. No chip loads a page or a frame (#726).
- *Today*: `stage-nav.ts` is shared by rig, compare and parts. The stage frames
  and the standalone interview command are deleted (#726). Chip 2 names itself
  unavailable until the modal passes its opener. Job screens have none.

### C2 Navigator (left panel)

A list the person moves through. One component with item renderers, not one per
screen.

- **MUST** support: a title, search/filter, items with a state badge, a current
  item, keyboard navigation (up/down, Enter), and an optional visibility toggle
  per item.
- **MUST** show progress when the list is a sequence of things to answer or
  judge: "answered n / total", each item marked answered, current, or not yet
  answered.
- Item kinds: parts/slots (rig, compare, parts, job parts), questions (interview,
  job interview-picks), jobs (hub), targets (owner workspace).
- **MUST** keep view controls (Parts select, Solo, Reference select) out of the
  progress list. They belong to the toolbars (C3/C4), so the list reads as one
  thing.
- Events: `select(itemId)`, `toggle(itemId, visible)`.
- *Today*: `PartExplorer` (rig, compare), the `parts.ts` list, the interview
  question picker select, the job sidebar selects, the hub list and the owner
  list are six separate builds.

### C3 Main toolbar

- **MUST** sit directly above the main view on every screen that has one, and
  hold the actions used on almost every visit: **Comment** (C8), the view
  control set (C5b), and **Sync cameras** where there is more than one pane.
- **MUST** visually separate it from the secondary toolbar (C4) without needing
  visible labels such as "main" and "secondary" (R1).
- Props: `items` (ordered, from a shared registry of toolbar items).

### C4 Secondary toolbar

- **MUST** hold screen-specific and less frequent controls: layer toggles
  (Images, Mesh edges, Bone points), Background, Alpha only, Footprints, Part
  opacity and Threshold, the chest and mesh editor bars, and the Parts, Solo and
  Reference selects.
- **MUST** use the same item components as C3. An item looks and behaves the
  same on every screen it appears on.
- *Today*: every screen has one toolbar holding everything (`index.html`
  `.viewbar`, `compare.html`, `parts.ts:94-143`, `job-session.ts:2452-2518`).

### C5 Main view

The inspected picture. One implementation for every screen.

- **MUST** be built from the shared viewport modules (`viewport-pair.ts`,
  `viewport-controller.ts` with a provider). A screen supplies a provider. It
  never writes its own camera, fit, zoom or pan (R3a, R4).
- **MUST** support 1 to 3 panes (reference, rig; reference, A, B; part,
  painting), each with a label, with camera sync on or off.
- **MUST** keep wheel zoom at the pointer, drag to pan, fit on resize, and exact
  numeric camera replay for saved comments. These are shared behaviors, not
  per-screen ones.
- Props: `panes`, `provider`, `sync`. Events: `camera-change`, `pointer-mark`
  (for C8).
- *Today*: rig, parts and job use `viewport-pair` + `viewport-controller`.
  Compare has its own three-pane markup and camera stack (`compare.ts:236`,
  `505-516`, `compare-playhead`, `camera-view`, `bindPan`). Interview has no main
  view. Its image preview is a separate `<img>` area.

#### C5b View control set

- **MUST** be one control group, in this order with these names on every screen:
  **Zoom in → Zoom out → Fit → 1:1 → View switch**, followed by the zoom value.
  It shows on every screen with a main view, including interview and job image
  answers.
- **MUST** have the View switch list the screen's views as modes of one control.
  - Rig: **Side by side · Reference · Rig**.
  - Parts: **Part · Overlay · Difference**, plus **Region · Pages** for an atlas.
  - Compare: the pane layouts.
  - Difference (R3) is a mode of the View switch and covers every region. There
    is no separate per-region evidence panel.
- *Today*: rig has −, +, Fit with no 1:1. Compare has −, +, "Fit synchronized
  views". Parts has −, value, +, Fit, 1:1. Job has Zoom in, Zoom out, Fit. One
  job page showed two orders at once.

### C6 Bottom panel

- **MUST** sit directly beneath the main view on every screen that has one, with
  a resizable separator, a collapsed state, and tabs (R3a).
- **Step 1 working-screen proposal**: keep the tab row and act button visible
  while the panel is collapsed. This is not approved; present it for the
  owner's second R0 ruling before step 1 merges.
- Tabs are per screen.
  - Rig Setup: Part · Modeling · Chest · Mesh · Weights · Bones · Fields · Cuts · Cloth.
  - Rig Animate: the timeline dock (C12), then Transport · Sound · Environment ·
    Physics · Idle tracks · Readings · Requirements · Retarget · Report.
  - Compare: View · Rig · Playback · Feedback.
  - Parts: Issues (C8 list) and Producer flags.
  - Interview and job: the pending acts (C9 and C10 forms) and Comments.
- **MUST** use one tab model. `inspector-blocks.ts` and `bindInspectorTabs`
  become one.
- *Today*: rig and compare have resizable bottom panels with different tab
  models. Parts, interview and job have none.

### C7 Side panel (right)

- **MUST** be optional per screen and resizable. It holds context that is read
  rather than edited: package context, checkpoints, source and provenance,
  producer flags, plan text, mesh geometry.
- **MUST NOT** hold a second copy of a list or evidence the main view already
  shows (R3).
- *Today*: parts uses `.pv-side` for flags, the mesh panel and issues. Compare
  puts the Parts explorer on the right.

### C8 Comments

The only feedback input (R2). Feedback says what is wrong and should be fixed.

- **MUST** allow any number of comments per submission, in order.
- **MUST** allow each comment to be general, or pinned to an image point, region,
  part, frame or frame range, or checkpoint. Pinned comments show on the main
  view and in the list.
- **MUST** use one composer (text, Delete) and one list (jump to pin, edit,
  delete) on every screen, including job rig and package screens.
- **MUST NOT** coexist with separate memo, review-notes, summary, per-part note,
  image note or `words` fields for feedback. Those are removed.
- Writes the `comments[]` value of the act it belongs to.
- *Today*: `stage-comments.ts` serves rig, compare and parts. Job rig and package
  screens have no comments. Feedback also enters through Review notes, the
  feedback summary field, the job per-ask Note and the image note.

### C9 Survey answer

The answer to a question the producer asked ("how should this be?"). It is a
separate input kind from comments.

- **MUST** render one question as: the question text, source information
  (folded), the options as radio cards (label, effect, **AI recommended** badge),
  **Other** with inline text, **Delegate** where offered, and the per-question
  **Note (optional)**.
- **MUST** support a set of questions answered together, with "n of m answered"
  and a **Save explicit picks** action.
- **MUST** be the same component in the standalone interview and in job
  interview-picks.
- Progress across questions lives in C2.
- *Today*: `interview-panel.ts` renders radios. `job-session.ts:1871-1940`
  rebuilds it as a `<select>`.

### C10 Act bar

The decision a person makes, and its submit action.

- **MUST** be one component placed at the end of the bottom panel's act tab
  on every screen, including embedded screens.
- **MUST** show a decision control and a submit button whose label names the act.
  - Review verdict: **Approved / Changes requested** → **Submit review**.
  - Parts verdict: derived from comments; no comments gives **Approve parts and
    sign off**, issues give **Request fixes (n issues)**.
  - Checkpoint: **Pass / Fail** → **Save checkpoint outcome**.
  - Signoff: **Save stage approval**.
  - Reopen: **Reopen stage**.
  - Interview: **Save explicit picks**.
- **MUST** show the save state (saved, unsaved, failed with retry) the same way
  on every screen.
- *Today*: rig and compare use a dialog with a status select. Parts uses **Save
  sign-off** under the side panel. Job uses one form per ask in a forms column.

### C11 Status bar

- **MUST** be one footer showing the save state, the source hash, and the
  screen's short status items.
- *Today*: `.status-bar` (rig), `<footer>` (compare), `#pv-save-status` (parts),
  and status paragraphs (interview, job, hub, owner).

### C12 Timeline and transport

- **MUST** be one component for play/pause, clip select, Repeat, time and frame
  go, and scrubbing. It lives at the top of the bottom panel on Animate and
  playback screens.
- *Today*: the rig timeline dock, the compare Playback tab, and `.job-transport`
  in job rig screens.

### C13 Read-only context blocks

Plan text, evidence tables, provenance, source binding, and direction metadata.

- **MUST** render through one block component in C7 or a C6 tab, with the same
  folding behavior everywhere.
- **MUST NOT** duplicate a checkpoint's visual evidence that the main view's
  Difference mode already covers (R3).

## 3. Screens

Each row lists the components present and the screen's configuration. A dash
means the component is absent.

| Screen | C2 Navigator | C5 Main view panes | C5b View switch modes | C6 Bottom tabs | C7 Side | C8 | C9 | C10 act |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Rig review | parts/slots | reference, rig | Side by side · Reference · Rig | Setup or Animate set | package context, checkpoints | yes | — | review verdict |
| Compare | parts/slots | reference, A, B | pane layouts | View · Rig · Playback · Feedback | sources | yes (frame range) | — | review verdict |
| Parts review | parts/regions | part, painting | Part · Overlay · Difference (· Region · Pages) | Issues · Producer flags | mesh geometry | yes | — | parts verdict |
| Interview | questions with progress | reference images | image tabs as modes | answers | source info | yes | yes | interview picks |
| Job: interview-picks | questions with progress | option images | image tabs as modes | answers | source info | yes | yes | interview picks |
| Job: parts | parts/regions | as Parts review | as Parts review | as Parts review | as Parts review | yes | — | parts verdict |
| Job: rig or package | parts/slots | reference, rig | as Rig review | acts · transport (C12) | binding, observation | yes | — | review verdict |
| Job: checkpoint | — | the checkpoint's views | includes Difference | acts | plan text, guidance | yes | — | checkpoint |
| Job: image set | images | the image | image list as modes | acts | — | yes | — | review verdict |
| Job: plan, signoff, reopen | — | — | — | acts | plan text | yes | — | signoff / reopen |
| Job hub | jobs | the selected job in an iframe until its safety proof | — | — | — | — | — | — |
| Owner workspace | targets | the selected target in an iframe until its safety proof | — | — | — | — | — | — |

Notes:

- The hub and owner workspace mount a target in place only after that target's
  safety-proof card proves no capability widening and preservation of grants,
  instance authority and hidden-frame pause. All other targets remain iframe
  documents served by the single `index.html` entry. No target is proven today,
  so step 6 starts with all targets in iframes.
- Interview and job interview-picks get a main view (C5) for their images, with
  the same control set, instead of a bare preview image.
- Comments (C8) are available on every screen with an act, so feedback outside
  the survey has one place to go.

## 4. Migration order

Each step leaves a working product. Each shared-component card adopts all
current hosts and removes the old body in the same PR, with a zero-hit search
for the copies it replaces.

1. C1 shell, C5 main view, C5b control set and C6 bottom panel inside
   `index.html`. The rig screen mounts through them. Old rig markup is removed.
2. Parts review and job parts move onto the shell. `parts.html` is removed.
3. Compare moves onto C5 and the shared camera. `compare.html`,
   `compare-html.ts` splicing and the compare camera stack are removed.
4. C9 survey, then interview and job interview-picks move. The job `<select>`
   rebuild is removed. (The interview entry page was deleted early with the stage frames, #726.)
5. Job rig, package, checkpoint, image-set, plan, signoff and reopen move. The
   inline job document in `job-front.ts` is removed.
6. Hub and owner workspace move. `job-hub.html` and `owner-workspace.html` are
   removed. All targets start in iframes under the single entry; in-place
   mounting requires each target's safety proof as specified in §3.
7. C8 replaces the remaining feedback fields (Review notes, summary, per-ask
   Note, image note). C10 and C11 unify the act and status.

Step 1 is released for implementation under the approved layout ruling. Before
its visible merge, send a working local URL to HQ for the owner's second R0
ruling, including the collapsed-panel proposal in C6. Steps 2–7 each need their
own layout ruling and remain **STOP** until then. Each also needs the owner's
working-screen ruling before merge (R0).
