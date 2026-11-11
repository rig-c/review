#!/usr/bin/env bash
set -euo pipefail
export OMP_NUM_THREADS=4 OPENBLAS_NUM_THREADS=4 UV_THREADPOOL_SIZE=4 RAYON_NUM_THREADS=4
# Existing owned CDP launcher discovers the pool's installed Chromium. No browser download.
bun tests/job-record-modal-browser.ts --lang en --out artifacts/710/en
bun tests/job-record-modal-browser.ts --lang ko --out artifacts/710/ko
