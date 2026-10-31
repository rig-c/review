#!/usr/bin/env bash
set -euo pipefail
export OMP_NUM_THREADS=4 OPENBLAS_NUM_THREADS=4 UV_THREADPOOL_SIZE=4 RAYON_NUM_THREADS=4
export PLAYWRIGHT_SKIP_BROWSER_GC=1
bun run typecheck
bun run build
bun test tests/turn-pad.test.ts tests/turn-feedback.test.ts tests/inspection-persistence.test.ts tests/feedback-validation.test.ts tests/theme.test.ts tests/compare.test.ts tests/rig-fields.test.ts tests/idle-tracks.test.ts tests/preview.test.ts
lane_tools="$PWD/.review-state/229/tools"
export PLAYWRIGHT_BROWSERS_PATH="$PWD/.review-state/229/browsers"
trap 'rm -rf "$lane_tools" "$PLAYWRIGHT_BROWSERS_PATH"' EXIT
mkdir -p "$lane_tools"
printf '{"private":true,"type":"module","dependencies":{"playwright":"1.56.1"}}\n' > "$lane_tools/package.json"
bun install --cwd "$lane_tools" --cache-dir "$lane_tools/cache" --backend copyfile
bun "$lane_tools/node_modules/playwright/cli.js" install chromium
bun scripts/turn-pad-browser.ts --out .review-state/229/evidence --playwright-module "$lane_tools/node_modules/playwright/index.mjs"
rm -rf "$lane_tools" "$PLAYWRIGHT_BROWSERS_PATH"
