# review

A private standalone human inspection and structured feedback app. Read README.md, docs/REVIEW_PACKAGE.md and docs/DESIGN.md before changing the delivery contract.

- Work here; do not edit rigc, parts or play core repositories as part of review changes.
- Keep supplied source assets and compiled models immutable. Motion is view/annotate/export only; never author keys or write motion.json. Store feedback separately, bound to package identity, revision and actual input hash. Opening a package never approves it.
- All package assets must remain inside the package directory, with literal portable paths and no symlink escape. Never execute a manifest command or fetch a remote asset on its behalf.
- Playback uses the published `@rig-c/play` API. A loaded model is not proof of the upstream compiler's gate. State source provenance and missing capabilities honestly.
- Modeling and motion are workspaces. Structured feedback is not an implemented mesh editor. Future modeling touch-up must preserve source provenance; motion authoring is outside this app. Do not label placeholders as working editing tools.
- Require same-origin JSON mutations, a loopback-only server, bounded payloads and no arbitrary filesystem endpoint.
- Run focused tests for path/state boundaries. Use the global nova-run skill for full test/build/typecheck bundles.
- Use Conventional Commits in English. Include `Co-Authored-By: Naru <342599188+fj-naru[bot]@users.noreply.github.com>` in agent-authored commits and final squash commits. Parent agent handles Git landing; execution agents do not run Git.
