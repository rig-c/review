# Development and release reference

See [Start](README.md#start) for installation and [AGENTS.md](https://github.com/rig-c/review/blob/main/AGENTS.md) for contributor verification policy.

## Development

From a clone:

```sh
bun install
bun run demo
```

Open the printed loopback URL. The bundled original lantern study has source art, a minimal synthetic compiled model (`skeleton.model.json` + `lantern.png`), an explicitly synthetic canonical pose-sequence sample and an original synthetic chime; `bun run demo` opens it with `--view-only` because it carries no producer handoff. Inside a clone, `bun run review -- <dir>`, `bun run check -- <dir>` and `bun src/cli.ts <command>` are the same CLI as `npx rig-review`.

```sh
bun run typecheck
bun test
bun run build
bun run smoke
```

`smoke` packs this tree, installs the tarball into an empty project, and runs the installed bin: `--help`, `open --help`, `check` on the bundled demo, and a served page whose browser bundle is built from the installed files. A file missing from `files` in `package.json` fails there, not after publishing.

The server bundles `web/main.ts` at startup using the pinned installed runtime, with no CDN. `build` verifies that browser bundle in memory. CI checks types, focused path/state/API tests, bundling and the demo package. Follow AGENTS.md for contributor verification policy. For a live run against the installed producers, [docs/LIVE_FIXTURE.md](docs/LIVE_FIXTURE.md) gives the public package, the producer bench and the open line that reaches `baseline: reproduced`. [DESIGN.md](docs/DESIGN.md) distinguishes the runnable foundation from future modeling touch-up and preserves the illustrative screen concept.

When adding server modules, inventory every test that copies the front and include `tests/server-lifecycle.test.ts` in focused verification.

### Releasing

Releases are published by `.github/workflows/release.yml` when a version tag (`vX.Y.Z`) is pushed or explicitly dispatched for recovery (`gh workflow run release.yml --ref vX.Y.Z -f tag=vX.Y.Z`). Before publishing, the `release` job checks out `main` history and tags, requires a strict `vX.Y.Z` tag ref (`RELEASE_TAG_FORM`, `RELEASE_REF_NOT_TAG`), resolves the tag through the commits API to a full commit SHA (`RELEASE_TAG_UNRESOLVED`), requires the run's `GITHUB_SHA` and fetched tag commit to equal that SHA (`PROVENANCE_SHA_MISMATCH`), verifies the commit is reachable from `origin/main` (`RELEASE_TAG_NOT_ON_MAIN`), verifies `package.json` in the tagged commit tree matches `@rig-c/review@X.Y.Z` (`RELEASE_TAG_VERSION_MISMATCH`), and refuses a version the registry already serves (`RELEASE_ALREADY_PUBLISHED`). Checkout in `publish` uses the validated commit SHA, verifies the `tree-verdict` publication gate on the tagged tree, and publishes `@rig-c/review` and the `rig-review` alias to npm through trusted publishing (OIDC) with provenance. No npm token is stored. See [RELEASING.md](RELEASING.md) for the publication gate and alias details.

