#!/usr/bin/env bash
# Launch one locale after the job adapter has verified the pinned archives.
set -euo pipefail
umask 077
case "${1:-}" in
  en|ko) export REVIEW_371_LANGUAGE="$1" ;;
  *) echo 'FOUR_STAGE_JOB_LANGUAGE: expected en or ko' >&2; exit 2 ;;
esac
if [ "$#" -ne 1 ]; then
  echo 'FOUR_STAGE_JOB_LANGUAGE: expected exactly one locale argument' >&2
  exit 2
fi
: "${REVIEW_371_OUTPUT:?Set a new Review evidence directory}"
if [ -e "$REVIEW_371_OUTPUT" ]; then
  echo 'FOUR_STAGE_JOB_OUTPUT_EXISTS: expected a new evidence directory' >&2
  exit 2
fi
cpus="$(python3 -c 'import os; print(",".join(map(str,sorted(os.sched_getaffinity(0))[:4])))')"
code=0
timeout --signal=TERM 600s taskset -c "$cpus" bun tests/four-stage-browser.ts || code=$?
mkdir -p "$REVIEW_371_OUTPUT"
post_inventory=POST_INVENTORY_INCOMPLETE
journal="$REVIEW_371_OUTPUT/walk-checkpoints.jsonl"
if [ -f "$journal" ] &&
   grep -Fq "\"key\":\"$REVIEW_371_LANGUAGE-inventory.copies.complete\"" "$journal" &&
   grep -Fq '"key":"inventory.originals.complete"' "$journal"; then
  post_inventory=complete
fi
if [ "$code" -eq 0 ] &&
   { [ "$post_inventory" != complete ] || ! grep -Fq '"key":"walk.complete"' "$journal"; }; then
  echo 'FOUR_STAGE_JOB_INCOMPLETE: missing completion checkpoint' >&2
  code=1
fi
printf '{"language":"%s","exitCode":%s,"postInventory":"%s"}\n' \
  "$REVIEW_371_LANGUAGE" "$code" "$post_inventory" > "$REVIEW_371_OUTPUT/walk-command.json"
exit "$code"
