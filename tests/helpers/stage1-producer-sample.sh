#!/usr/bin/env bash
set -euo pipefail
export NODE_OPTIONS=--max-old-space-size=4096
mkdir -p "$HOME/.cache/rv367"
owned_tmp=$(mktemp -d "$HOME/.cache/rv367/p.XXXXXX")
trap 'rm -rf -- "$owned_tmp"' EXIT
export TMPDIR="$owned_tmp"
mkdir -p "$owned_tmp/bench" artifacts/stage1-sample
printf '%s\n' '{"name":"stage1-producer-bench","private":true,"dependencies":{"@rig-c/parts":"1.78.0","@rig-c/core":"2.81.0"}}' > "$owned_tmp/bench/package.json"
(cd "$owned_tmp/bench" && timeout 90 bun install)
bun tests/helpers/stage1-live-package.ts "$owned_tmp/pkg"
time timeout 120 bun "$owned_tmp/bench/node_modules/@rig-c/parts/cli.ts" rig --config "$owned_tmp/pkg/config.json" --parts "$owned_tmp/pkg/out" --out "$owned_tmp/pkg/out/rig"
time timeout 180 bun "$owned_tmp/bench/node_modules/@rig-c/parts/cli.ts" check --rig "$owned_tmp/pkg/out/rig" --parts "$owned_tmp/pkg/out" --out "$owned_tmp/pkg/out/check" --page-edges free --pack-shape polygon
cp "$owned_tmp/pkg/out/check/check.json" artifacts/stage1-sample/check.json
cp "$owned_tmp/pkg/out/rig/rig.json" artifacts/stage1-sample/rig.json
cp "$owned_tmp/pkg/out/check/build/skeleton.model.json" artifacts/stage1-sample/skeleton.model.json
