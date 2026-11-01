<p align="center">
  <img src="https://raw.githubusercontent.com/rig-c/review/main/assets/banner.svg" alt="@rig-c/review" width="100%" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@rig-c/review"><img src="https://img.shields.io/npm/v/@rig-c/review.svg?style=flat-square&color=FF6B4A" alt="version"/></a>
  <a href="https://www.npmjs.com/package/@rig-c/review"><img src="https://img.shields.io/npm/dm/@rig-c/review.svg?style=flat-square&color=EC4899" alt="downloads"/></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-38BDF8.svg?style=flat-square" alt="MIT"/></a>
</p>

# review

A reusable local workspace for a person to inspect an agent's rig output, compare source references, and export feedback ready to become an issue. The person receives a package or opens an existing output folder; the agent does not build a new viewer for each rig.

The app provides one inspection workspace for setup geometry and motion, compiled-model playback through `@rig-c/play`, local image, video and pose-sequence references, checkpoints, audio audition, and saved structured feedback. **The producer writes motion in scratch; review never authors keys.** Navigation changes inspection time; it never retimes, and review never writes the package's `motion.json`: motion edits are data (config patches, pose maps, retarget flags) the installed producer turns into a scratch build. Meshes are edited in setup space and rebuilt by the producer (`rig-parts remesh --delta`, #100/#135); weights and source art are not edited.

## Place in the toolchain

[Parts](https://github.com/rig-c/parts) → [Pose](https://github.com/rig-c/pose) →
[Core / rigc](https://github.com/rig-c/core) → **Review** →
[Play](https://github.com/rig-c/play) → **Adapter** (consumer integration).

Review is the human inspection and source-bound feedback gate in this delivery
flow. It inspects the upstream build without replacing Core's compiler gate, and
its motion edits are data the installed producer builds in scratch. Review itself uses the published Play runtime for previews;
the chain describes delivery and feedback responsibilities, not runtime import
order. Adapter denotes downstream consumer integration, without depending on the
published adapters (`@rig-c/pixi`, `@rig-c/phaser`, `@rig-c/three`) or changing
existing compilation/playback dependencies.

## Start

Install it beside the agent that produced the output, then open that output folder:

```sh
npm i -D @rig-c/review
npx rig-review open /absolute/path/to/output
```

`rig-review` is also the convenience package name: `npm i -D rig-review` installs
the same CLI. `@rig-c/review` remains the canonical package.

`rig-review` runs under **Bun 1.3.0 or later**, which must be on `PATH`; CI runs the installed package on 1.3.0 and on the latest Bun. `open` prints a loopback URL and exits; see [One-command owner handoff](#one-command-owner-handoff). `npx rig-review --help` lists every command.

The package is 0.x: the CLI is the supported surface, and no importable API is promised yet (`exports` exposes only `package.json`).

Example stdout from `open` (instance values vary):

```text
http://127.0.0.1:4318/instances/<key>/?input=…&handoff=…#cap=…
```

## What you can do

| Task | Command or panel | Destination |
| --- | --- | --- |
| **Hand off and compare** | | |
| <a id="one-command-owner-handoff"></a>Open an inspection | `open` | [Owner handoff — WORKFLOWS](docs/WORKFLOWS.md#one-command-owner-handoff) |
| <a id="existing-output-handoff"></a>Inspect an existing folder | `check`, `review` | [Existing output handoff — WORKFLOWS](docs/WORKFLOWS.md#existing-output-handoff) |
| <a id="compare-two-outputs"></a>Compare two builds against a video | `compare` | [Compare two outputs — WORKFLOWS](docs/WORKFLOWS.md#compare-two-outputs) |
| <a id="feedback-ownership"></a>Retrieve submitted feedback | `feedback` | [Feedback ownership — WORKFLOWS](docs/WORKFLOWS.md#feedback-ownership) |
| <a id="frame-strip-export"></a>Export feedback intervals as strips | `strip` | [Frame strip export — WORKFLOWS](docs/WORKFLOWS.md#frame-strip-export) |
| **Inspect** | | |
| <a id="workspace-settings-and-panels"></a>Navigate the workspace | Setup, Animate, Compare, Settings | [Workspace panels — PANELS](docs/PANELS.md#workspace-settings-and-panels) |
| <a id="inspect-animation-keys"></a>Inspect stored animation keys | Timeline, Curves, Bone tree | [Animation keys — PANELS](docs/PANELS.md#inspect-animation-keys) |
| <a id="inspect-a-part"></a>Select and fit a model slot | Parts explorer | [Part inspection — PANELS](docs/PANELS.md#inspect-a-part) |
| <a id="weights-setup-pose-watch-only"></a>Inspect setup-pose weights | Weights | [Weights — PANELS](docs/PANELS.md#weights-setup-pose-watch-only) |
| Steer model turn dials and compare at one angle | Turn pad | [Turn inspection — PANELS](docs/PANELS.md#turn-pad) |
| **Edit through the producer** | | |
| <a id="chest-regions-designate-rebuild-watch"></a>Designate chest regions and rebuild | Chest regions | [Chest regions — PANELS](docs/PANELS.md#chest-regions-designate-rebuild-watch) |
| <a id="mesh-panel-density-regions-segments--remesh"></a>Rebuild a part from mesh parameters | Mesh | [Mesh parameters — PANELS](docs/PANELS.md#mesh-panel-density-regions-segments--remesh) |
| <a id="bones-config-anchors-check-rebuild"></a>Check and rebuild config anchors | Bones | [Bones — PANELS](docs/PANELS.md#bones-config-anchors-check-rebuild) |
| <a id="rig-fields-regions-still-row-stops-inherit-turn"></a>Adjust producer config fields | Rig fields | [Rig fields — PANELS](docs/PANELS.md#rig-fields-regions-still-row-stops-inherit-turn) |
| <a id="cuts-cut-polygons-patch-boxes-limb-joints--rig-parts-build"></a>Designate cuts, patches and limb joints | Cuts | [Cuts — PANELS](docs/PANELS.md#cuts-cut-polygons-patch-boxes-limb-joints--rig-parts-build) |
| <a id="mesh-edit-typed-delta-preview-only"></a>Preview a setup-space delta and rebuild | Edit Mesh | [Mesh edit — PANELS](docs/PANELS.md#mesh-edit-typed-delta-preview-only) |
| <a id="retarget-map-flags--rig-pose-watch"></a>Retarget a declared pose sequence | Retarget | [Retarget — PANELS](docs/PANELS.md#retarget-map-flags--rig-pose-watch) |
| Mark a point or region on the current view | Comment · C | [Stage comments — PANELS](docs/PANELS.md#stage-comments) |
| **Control and share** | | |
| <a id="control-the-current-inspection-page"></a>Control an opted-in inspection | `control` | [Inspection control — WORKFLOWS](docs/WORKFLOWS.md#control-the-current-inspection-page) |
| <a id="keep-and-share-an-inspection"></a>Restore a view link or local draft | View link, draft | [Keep and share — WORKFLOWS](docs/WORKFLOWS.md#keep-and-share-an-inspection) |
| <a id="launcher-contract"></a>Start or reuse the launcher | `open` | [Launcher contract — WORKFLOWS](docs/WORKFLOWS.md#launcher-contract) |
| <a id="managed-front-and-write-capability"></a>Use the managed front and write capability | `open` | [Managed front — WORKFLOWS](docs/WORKFLOWS.md#managed-front-and-write-capability) |

## License

MIT. See [LICENSE](LICENSE).

## Links

<a id="development"></a><a id="releasing"></a>
Development and releasing: [Contributing workflows](https://github.com/rig-c/review/blob/main/CONTRIBUTING.md#development).

- [Package contract](docs/REVIEW_PACKAGE.md)
- [Product design](docs/DESIGN.md)
- [Animation inspection](docs/ANIMATION_INSPECTION.md)
- [Installed-producer fixture](docs/LIVE_FIXTURE.md)
