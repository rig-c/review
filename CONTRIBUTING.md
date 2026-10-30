# Development and release reference

See [Start](README.md#start) for installation and [AGENTS.md](https://github.com/rig-c/review/blob/main/AGENTS.md) for contributor verification policy.

## Development

From a clone:

```sh
bun install
bun run demo
```

Open the printed loopback URL. The bundled original lantern study has source art, an explicitly synthetic canonical pose-sequence sample and an original synthetic chime. It has no compiled model: playback remains unavailable until a real model is supplied. Inside a clone, `bun run review -- <dir>`, `bun run check -- <dir>` and `bun src/cli.ts <command>` are the same CLI as `npx rig-review`.

```sh
bun run typecheck
bun test
bun run build
bun run smoke
```

`smoke` packs this tree, installs the tarball into an empty project, and runs the installed bin: `--help`, `open --help`, `check` on the bundled demo, and a served page whose browser bundle is built from the installed files. A file missing from `files` in `package.json` fails there, not after publishing.

The server bundles `web/main.ts` at startup using the pinned installed runtime, with no CDN. `build` verifies that browser bundle in memory. CI checks types, focused path/state/API tests, bundling and the demo package. Follow AGENTS.md for contributor verification policy. For a live run against the installed producers, [docs/LIVE_FIXTURE.md](docs/LIVE_FIXTURE.md) gives the public package, the producer bench and the open line that reaches `baseline: reproduced`. [DESIGN.md](docs/DESIGN.md) distinguishes the runnable foundation from future modeling touch-up and preserves the illustrative screen concept.

### Releasing

Releases are cut by `.github/workflows/release.yml`. On every push to main, release-please keeps a `release: vX.Y.Z` pull request whose version comes from the conventional-commit subjects since the last release. Merging it tags the version, creates the GitHub release, runs typecheck and the install smoke on the tagged tree, and publishes to npm through trusted publishing (OIDC) with provenance. No npm token is stored. Nothing is published until a release PR is merged. Before publishing, the push path resolves the cut tag's commit and requires it to equal the run's `GITHUB_SHA`; a re-run with an older SHA refuses `PROVENANCE_SHA_MISMATCH`, reports both SHAs and leaves the tag cut for recovery. Checkout uses the validated commit SHA. A manual dispatch only re-publishes an existing tag whose GitHub release release-please created, whose commit is on main, and whose version the registry does not serve yet. It must be dispatched on the tag itself (`gh workflow run release.yml --ref vX.Y.Z -f tag=vX.Y.Z`): npm provenance names the run's commit, so a run whose commit is not the tag's is refused `PROVENANCE_SHA_MISMATCH`. Only a tag cut after that check carries it.

