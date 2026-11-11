#!/usr/bin/env bash
set -euo pipefail
export UV_THREADPOOL_SIZE=4
export NODE_OPTIONS=--max-old-space-size=4096
out=artifacts/interview-modal-722-repair-60d7f17
mkdir -p "$out"
bun run typecheck > "$out/typecheck.log" 2>&1 || { cat "$out/typecheck.log"; exit 1; }
bun tests/job-record-screen-browser.ts --interview-only --out "$out" > "$out/browser.log" 2>&1 || { tail -80 "$out/browser.log"; exit 1; }
tail -10 "$out/browser.log"
