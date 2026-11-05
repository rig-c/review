#!/usr/bin/env bash
set -euo pipefail
unset DISPLAY WAYLAND_DISPLAY
export PLAYWRIGHT_SKIP_BROWSER_GC=1 NODE_OPTIONS=--max-old-space-size=4096
mkdir -p "$HOME/.cache/rv367"
owned_tmp=$(mktemp -d "$HOME/.cache/rv367/t.XXXXXX")
trap 'rm -rf -- "$owned_tmp"' EXIT
export TMPDIR="$owned_tmp"
mkdir "$owned_tmp/bench"
export RV367_PARTS_VERSION=${RV367_PARTS_VERSION:-1.78.0} RV367_CORE_VERSION=${RV367_CORE_VERSION:-2.81.0}
bun -e 'await Bun.write(process.argv[1],JSON.stringify({name:"stage1-producer-bench",private:true,dependencies:{"@rig-c/parts":process.env.RV367_PARTS_VERSION,"@rig-c/core":process.env.RV367_CORE_VERSION}}))' "$owned_tmp/bench/package.json"
(cd "$owned_tmp/bench" && timeout 90 bun install)
export RV367_BENCH="$owned_tmp/bench"
bun -e 'if(process.env.TMPDIR.length+64>=108)throw Error("TMPDIR_TOO_LONG")'
timeout 420 bun tests/stage1-corrections-browser.ts
