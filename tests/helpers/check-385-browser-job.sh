#!/usr/bin/env bash
set -euo pipefail
unset DISPLAY WAYLAND_DISPLAY
export PLAYWRIGHT_SKIP_BROWSER_GC=1
mkdir -p "$HOME/.cache/rv385"
owned_tmp=$(mktemp -d "$HOME/.cache/rv385/t.XXXXXX")
trap 'rm -rf -- "$owned_tmp"' EXIT
export TMPDIR="$owned_tmp"
# Static bound for Chromium's Unix socket (108 bytes), before launching any browser.
bun -e 'const n=process.env.TMPDIR.length+64;console.log("CHROMIUM_TMP_PATH_BOUND "+n);if(n>=108)throw Error("TMPDIR_TOO_LONG");'
timeout 540 bun tests/parts-classification-browser.ts
