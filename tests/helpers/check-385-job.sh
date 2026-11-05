#!/usr/bin/env bash
set -euo pipefail
unset DISPLAY WAYLAND_DISPLAY
export PLAYWRIGHT_SKIP_BROWSER_GC=1
mkdir -p .lane-385/producer .lane-385/tmp
export TMPDIR="$PWD/.lane-385/tmp"
export BUN_INSTALL_CACHE_DIR="$PWD/.lane-385/bun-cache"
printf '%s\n' '{"name":"review-check-fixture","private":true,"dependencies":{"@rig-c/parts":"2.17.0"}}' > .lane-385/producer/package.json
(cd .lane-385/producer && bun install)
touch .lane-385/producer/node_modules/.metadata_never_index
bun tests/helpers/prepare-check-385.ts evidence/real-check .lane-385/producer/node_modules/@rig-c/parts --preflight
timeout 540 bun tests/helpers/prepare-check-385.ts evidence/real-check .lane-385/producer/node_modules/@rig-c/parts
