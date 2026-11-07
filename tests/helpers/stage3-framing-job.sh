#!/usr/bin/env bash
# Focused #496 post-fix probe, one locale per ordinary Nova receipt.
set -euo pipefail
unset DISPLAY WAYLAND_DISPLAY
export NODE_OPTIONS=--max-old-space-size=4096
probe_language=${1:-en}
case "$probe_language" in en|ko) ;; *) echo 'STAGE3_PROBE_LANGUAGE' >&2; exit 2 ;; esac
export RV496_LANG="$probe_language"
export RV496_ARTIFACTS="artifacts/stage3-framing-postfix-$probe_language"
exec timeout 480 bun tests/stage3-framing-browser.ts
