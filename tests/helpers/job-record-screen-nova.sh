#!/usr/bin/env bash
set -euo pipefail
export UV_THREADPOOL_SIZE=4
export NODE_OPTIONS=--max-old-space-size=4096
out=artifacts/record-screen-750
mkdir -p "$out"
trap 'status=$?; if [ "$status" -ne 0 ]; then tail -100 "$out/typecheck.log" "$out/browser.log" 2>/dev/null || true; fi; exit "$status"' EXIT
/usr/bin/time -v bun run typecheck > "$out/typecheck.log" 2>&1
/usr/bin/time -v bun tests/job-record-screen-browser.ts --out "$out" > "$out/browser.log" 2>&1
tail -20 "$out/browser.log"
