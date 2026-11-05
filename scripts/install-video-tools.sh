#!/usr/bin/env bash
set -euo pipefail

refuse() {
  echo "::error::$1: $2" >&2
  exit 1
}

[[ "$(uname -s):$(uname -m)" == Linux:x86_64 ]] ||
  refuse VIDEO_TOOLS_PLATFORM "expected Linux x86_64"

url=${VIDEO_TOOLS_URL:-}
version=${VIDEO_TOOLS_VERSION:-}
sha=${VIDEO_TOOLS_SHA256:-}
source_pattern='^https://github\.com/BtbN/FFmpeg-Builds/releases/download/autobuild-([0-9]{4})-([0-9]{2})-([0-9]{2})-[0-9]{2}-[0-9]{2}/ffmpeg-(n([0-9]+\.[0-9]+)\.[0-9]+-[0-9]+-g[0-9a-f]+)-linux64-gpl-([0-9]+\.[0-9]+)\.tar\.xz$'
[[ "$url" =~ $source_pattern ]] ||
  refuse VIDEO_TOOLS_PIN "expected a dated BtbN Linux x64 static GPL archive"
[[ "$version" == "${BASH_REMATCH[4]}-${BASH_REMATCH[1]}${BASH_REMATCH[2]}${BASH_REMATCH[3]}" &&
   "${BASH_REMATCH[5]}" == "${BASH_REMATCH[6]}" && "$sha" =~ ^[0-9a-f]{64}$ ]] ||
  refuse VIDEO_TOOLS_PIN "source, version, or SHA-256 pin is invalid"

archive="$RUNNER_TEMP/reference-video-tools.tar.xz"
case ${VIDEO_TOOLS_CACHE_HIT:-} in
  true)
    [[ -f "$archive" && ! -L "$archive" ]] ||
      refuse VIDEO_TOOLS_CACHE "cache hit did not restore the archive"
    echo "Video tools cache HIT"
    ;;
  '')
    [[ ! -e "$archive" && ! -L "$archive" ]] ||
      refuse VIDEO_TOOLS_CACHE "archive exists without an exact cache hit"
    echo "Video tools cache MISS"
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
      --output "$archive" "$url" ||
      refuse VIDEO_TOOLS_DOWNLOAD "could not download $url"
    ;;
  *) refuse VIDEO_TOOLS_CACHE "cache did not match the exact SHA-256 key" ;;
esac

digest=$(sha256sum "$archive") ||
  refuse VIDEO_TOOLS_SHA256_READ "could not hash the archive"
[[ "${digest%% *}" == "$sha" ]] ||
  refuse VIDEO_TOOLS_SHA256_MISMATCH "expected $sha, got ${digest%% *}"
echo "Video tools archive verified: $sha"

bin=$(mktemp -d "$RUNNER_TEMP/reference-video-tools.XXXXXX")
root=${url##*/}
root=${root%.tar.xz}
tar -xJf "$archive" -C "$bin" --strip-components=2 "$root/bin/ffmpeg" "$root/bin/ffprobe" ||
  refuse VIDEO_TOOLS_MISSING "archive must contain both ffmpeg and ffprobe"
export PATH="$bin:$PATH"
for tool in ffmpeg ffprobe; do
  [[ -f "$bin/$tool" && -x "$bin/$tool" && ! -L "$bin/$tool" &&
     "$(command -v "$tool")" == "$bin/$tool" ]] ||
    refuse VIDEO_TOOLS_MISSING "$tool must resolve to the verified extraction"
done
for tool in ffmpeg ffprobe; do
  echo "Resolved $tool: $bin/$tool"
  readback=$("$bin/$tool" -version) ||
    refuse VIDEO_TOOLS_VERSION "$tool -version failed"
  printf '%s\n' "$readback"
  [[ "$readback" == "$tool version $version "* ]] ||
    refuse VIDEO_TOOLS_VERSION "$tool did not report $version"
done
printf '%s\n' "$bin" >> "$GITHUB_PATH"
