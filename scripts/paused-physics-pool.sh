#!/usr/bin/env bash
set -euo pipefail
export OMP_NUM_THREADS=4 OPENBLAS_NUM_THREADS=4 UV_THREADPOOL_SIZE=4 RAYON_NUM_THREADS=4
lane_tools="$PWD/.review-state/346/tools"
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.review-state/346/browsers"
trap 'rm -rf "$lane_tools" "$PLAYWRIGHT_BROWSERS_PATH"' EXIT
mkdir -p "$lane_tools"
printf '{"private":true,"type":"module","dependencies":{"playwright":"1.56.1"}}\n' > "$lane_tools/package.json"
bun install --cwd "$lane_tools" --backend copyfile
bun "$lane_tools/node_modules/playwright/cli.js" install chromium
timeout 120 bun scripts/paused-physics-browser.ts "$lane_tools/node_modules/playwright/index.mjs"
