#!/usr/bin/env bash
set -euo pipefail
unset DISPLAY WAYLAND_DISPLAY
export PLAYWRIGHT_SKIP_BROWSER_GC=1 NODE_OPTIONS=--max-old-space-size=4096
mkdir -p "$HOME/.cache/rv367"
owned_tmp=$(mktemp -d "$HOME/.cache/rv367/f.XXXXXX")
trap 'rm -rf -- "$owned_tmp"' EXIT
export TMPDIR="$owned_tmp"
mkdir "$owned_tmp/bench"
bun -e 'await Bun.write(process.argv[1],JSON.stringify({name:"stage1-review-fixes",private:true,dependencies:{"@rig-c/parts":"2.18.0","@rig-c/core":"3.4.0"}}))' "$owned_tmp/bench/package.json"
(cd "$owned_tmp/bench" && timeout 90 bun install)
export RV367_BENCH="$owned_tmp/bench"
timeout 180 bun tests/stage1-review-fixes-browser.ts
