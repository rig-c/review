# Releasing

`.github/workflows/release.yml` publishes the validated release commit through
npm trusted publishing on a GitHub-hosted runner. Both the ordinary cut and tag
recovery retain their existing commit/provenance and registry guards.

## The publish gate and packing order

`npm publish --provenance --access public` runs `prepublishOnly`: typecheck,
`bun test`, both in-memory browser builds, the bundled demo's `check`, and the
empty-install smoke. The release runner installs ffmpeg/ffprobe for the full
suite. `npm publish --dry-run --provenance --access public` runs the same gate
without publishing. Full checks and builds run on the Nova pool during development.

The app ships its `src/` and `web/` sources. `bun run build` validates both web
bundles in memory; it writes no bundle to pack. The installed server builds from
the shipped web sources against its installed runtime. The scoped publish gates
and packs those files first. **Publish the alias rig-review** then packs that
same checkout and changes only the `name` line in its packed `package.json` to
`rig-review`. It keeps the scoped version, bin, dependencies, paths and all other
unpacked bytes, including web sources and assets. The script checks equality
before printing a usable tarball path. The alias tarball publish follows the
scoped publish's condition, OIDC permission and `--provenance --access public`.
Publishing the tarball does not rerun the checkout's gate.

`scripts/alias_tarball.ts pack --name rig-review --out <directory>` writes the
alias; `compare <scoped.tgz> <alias.tgz>` checks its paths and bytes. A content
difference exits 1 and names its path. Bad arguments or a failed pack/extraction
exit 2. Alias packs run `npm pack .` in the source directory with
`--ignore-scripts --dry-run=false` and a private no-op `--script-shell`. npm
10.9.9's pack directory fetcher otherwise executes `prepare` despite `--ignore-scripts`;
the no-op shell prevents lifecycle text from executing on that path too. It is
removed after the pack. Neither package.json nor installed npm files are edited.
The helper reads the one new tarball file, independent of npm's stdout JSON shape.
The install smoke keeps its npm 12 object / earlier array parser; its internal pack
also passes `--ignore-scripts`
and overrides dry-run, and its empty install overrides dry-run. Registry,
authentication and cache settings remain inherited. Tests include real npm
`prepublishOnly` lifecycle controls with the release flags, with and without
dry-run, and planted byte, missing, extra, version and formatting differences.
The focused alias regression pairs a native pack control that must reach the planted `prepare` exit 24, while helper
packs retain the manifest's exact bytes and suppress prepack, prepare and postpack.
An unrelated caller directory, inherited dry-run and script-shell settings, and
unchanged registry/auth/cache configuration are covered alongside that control.

After publishing, confirmation waits for both names at the release version,
then installs `rig-review@<version>` into an empty project, checks its manifest's
name and version, and runs the installed `rig-review --help`.

## First alias publish: owner only, once

The first `rig-review` package cannot use a trusted publisher until it exists.
This change publishes nothing. Choose the stable release tag containing this
script whose scoped publish has passed. From a clean checkout of that tag, the
owner runs (replace `vX.Y.Z`):

```sh
set -euo pipefail
release_tag=vX.Y.Z
test -z "$(git status --porcelain)"
git checkout --detach "$release_tag"
test -z "$(git status --porcelain)"
test "$(git describe --tags --exact-match HEAD)" = "$release_tag"
test "v$(node -p "require('./package.json').version")" = "$release_tag"
bun install --frozen-lockfile
npm run prepublishOnly
alias_out=$(mktemp -d)
alias_tgz=$(bun scripts/alias_tarball.ts pack --name rig-review --out "$alias_out")
npm publish "$alias_tgz"
```

The last command is plain `npm publish <alias tarball>`: the owner's account
handles its 2FA prompt. Add no token, explicit OTP or provenance flag to this
one-time account publish. Keep the printed tarball path until confirmation.
On npmjs.com → **rig-review** → Settings → Trusted Publisher → GitHub Actions,
enter these case-sensitive fields separately from the scoped package's publisher:

| Field | Value |
| --- | --- |
| Organization or user | `rig-c` |
| Repository | `review` |
| Workflow filename | `release.yml` |
| Environment name | blank |

Set Publishing access to **Require two-factor authentication and disallow
tokens**. Subsequent releases publish both names through the workflow. The
one-time account publish has no workflow provenance; later OIDC publishes do.

If the first cut stops at the alias step after the scoped publish, finish the
owner bootstrap, then confirm both registry versions and run
`bun scripts/confirm-alias.ts X.Y.Z` from the release checkout. The workflow's
`tag` recovery refuses an already published scoped version; it is not an
alias-only retry. README install recommendations wait for a later change after
the first alias publish and empty-install confirmation have been verified.
