#!/usr/bin/env bash
set -euo pipefail
export OMP_NUM_THREADS=4 OPENBLAS_NUM_THREADS=4 UV_THREADPOOL_SIZE=4 RAYON_NUM_THREADS=4
export NODE_OPTIONS=--max-old-space-size=4096
# One focused browser script; the sample and complete run are bounded to ten minutes.
bun run typecheck
timeout 600 bun tests/job-record-modal-browser.ts --out artifacts/715 "$@"
