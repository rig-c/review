# review

A reusable local workspace for a person to inspect an agent's rig output, compare source references, and export feedback ready to become an issue. The person receives a package or opens an existing output folder; the agent does not build a new viewer for each rig.

The app provides one inspection workspace for setup geometry and motion, compiled-model playback through `@rig-c/play`, local image, video and pose-sequence references, checkpoints, audio audition, and saved structured feedback. **The producer writes motion in scratch; review never authors keys.** Navigation changes inspection time; it never retimes, and review never writes the package's `motion.json`: motion edits are data (config patches, pose maps, retarget flags) the installed producer turns into a scratch build. Meshes are edited in setup space and rebuilt by the producer (`rig-parts remesh --delta`, #100/#135); weights and source art are not edited.

## Place in the toolchain

[Parts](https://github.com/rig-c/parts) → [Pose](https://github.com/rig-c/pose) →
[Core / rigc](https://github.com/rig-c/core) → **Review** →
[Play](https://github.com/rig-c/play) → **Adapter** (consumer integration).

Review is the human inspection and source-bound feedback gate in this delivery
flow. It inspects the upstream build without replacing Core's compiler gate or
authoring motion. Review itself uses the published Play runtime for previews;
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

## Existing output handoff

Use `check` and `review` to inspect an existing folder or curated package; see [the reference](docs/WORKFLOWS.md#existing-output-handoff).

## Compare two outputs

Compare two compiled packages against one selected local video; see [the reference](docs/WORKFLOWS.md#compare-two-outputs).

## Feedback ownership

Retrieve an explicitly submitted review with `feedback`; see [the reference](docs/WORKFLOWS.md#feedback-ownership).

## Development

Build, test and release from a clone; see [the reference](https://github.com/rig-c/review/blob/main/CONTRIBUTING.md#development).

### Releasing

See the [release workflow](https://github.com/rig-c/review/blob/main/CONTRIBUTING.md#releasing).

## Frame strip export

Export inclusive feedback intervals with `strip`; see [the reference](docs/WORKFLOWS.md#frame-strip-export).

## One-command owner handoff

Start or reuse a fixed inspection with `open`; see [the reference](docs/WORKFLOWS.md#one-command-owner-handoff).

### Launcher contract

See the [launcher contract](docs/WORKFLOWS.md#launcher-contract).

### Managed front and write capability

See the [managed front and write capability](docs/WORKFLOWS.md#managed-front-and-write-capability).

## Control the current inspection page

Observe or control an opted-in inspection with `control`; see [the reference](docs/WORKFLOWS.md#control-the-current-inspection-page).

## Keep and share an inspection

Restore a source-bound view link or local draft; see [the reference](docs/WORKFLOWS.md#keep-and-share-an-inspection).

## Workspace settings and panels

Navigate Setup, Animate, Settings and the review dialog; see [the reference](docs/PANELS.md#workspace-settings-and-panels).

## Inspect animation keys

Inspect the stored Timeline, Curves and Bone tree; see [the reference](docs/PANELS.md#inspect-animation-keys).

## Inspect a part

Select, fit and inspect an actual model slot; see [the reference](docs/PANELS.md#inspect-a-part).

## Chest regions (designate, rebuild, watch)

Designate chest regions and rebuild through the installed producer; see [the reference](docs/PANELS.md#chest-regions-designate-rebuild-watch).

## Mesh panel (density, regions, segments → remesh)

Rebuild a selected part from mesh parameters; see [the reference](docs/PANELS.md#mesh-panel-density-regions-segments--remesh).

## Weights (setup pose, watch only)

Inspect stored setup-pose weights; see [the reference](docs/PANELS.md#weights-setup-pose-watch-only).

## Bones (config anchors, check, rebuild)

Check and rebuild producer config anchors; see [the reference](docs/PANELS.md#bones-config-anchors-check-rebuild).

## Rig fields (regions, still row, stops, inherit, turn)

Adjust producer config fields through scratch rebuilds; see [the reference](docs/PANELS.md#rig-fields-regions-still-row-stops-inherit-turn).

## Cuts (cut polygons, patch boxes, limb joints → rig-parts build)

Send cut, patch and limb designations to the producer; see [the reference](docs/PANELS.md#cuts-cut-polygons-patch-boxes-limb-joints--rig-parts-build).

## Mesh edit (typed delta, preview only)

Preview a typed setup-space delta and rebuild through the producer; see [the reference](docs/PANELS.md#mesh-edit-typed-delta-preview-only).

## Retarget (map, flags → rig-pose, watch)

Retarget a declared pose sequence through the installed producer; see [the reference](docs/PANELS.md#retarget-map-flags--rig-pose-watch).

## License

MIT. See [LICENSE](LICENSE).

## Links

- [Package contract](docs/REVIEW_PACKAGE.md)
- [Product design](docs/DESIGN.md)
- [Animation inspection](docs/ANIMATION_INSPECTION.md)
- [Installed-producer fixture](docs/LIVE_FIXTURE.md)
