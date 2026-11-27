#!/usr/bin/env bash
# Prepare the public #361 Luna candidate for #1306. Requires curl >= 7.66,
# sha256sum and jq, plus FFmpeg with libx264 and ffprobe for the MP4.
set -euo pipefail
export LC_ALL=C

usage() {
  printf 'Usage: bash %s [--sources-only] <new-output-directory>\n' "$0" >&2
}

sources_only=false
if [[ ${1:-} == --sources-only ]]; then
  sources_only=true
  shift
fi
if [[ $# != 1 || -z $1 || $1 == -* ]]; then
  usage
  exit 2
fi

require_tool() {
  command -v "$1" >/dev/null || { printf 'Required fixture tool is missing: %s\n' "$1" >&2; exit 1; }
}

for tool in curl sha256sum jq; do
  require_tool "$tool"
done
ffmpeg=${RIG_REVIEW_FFMPEG:-ffmpeg}
ffprobe=${RIG_REVIEW_FFPROBE:-ffprobe}
if [[ $sources_only == false ]]; then
  require_tool "$ffmpeg"
  require_tool "$ffprobe"
fi

commit=a575f92d8f9f1bbdead27f8f346a548d104a6c17
base=https://raw.githubusercontent.com/rig-c/examples/$commit
luna=family/luna
source_frames=$luna/out/check/idle_frames

mkdir -- "$1"
out=$(cd -- "$1" && pwd -P)
cd -- "$out"
mkdir -p package/build source/idle

verify_sha() {
  local file=$1 expected=$2 actual
  actual=$(sha256sum "$file")
  if [[ ${actual%% *} != "$expected" ]]; then
    printf 'SHA-256 mismatch for %s\n' "$file" >&2
    exit 1
  fi
}

fetch() {
  local upstream=$1 destination=$2 sha=$3
  curl --fail --silent --show-error --location --retry 2 -o "$destination" "$base/$upstream"
  verify_sha "$destination" "$sha"
  printf '%s\t%s\t%s\n' "$upstream" "$destination" "$sha" >> source/files.tsv
}

fetch "$luna/out/check/build/skeleton.model.json" package/build/skeleton.model.json 843b7f307c18b150f3f510d2d1534291021a62ac867fd5b44fb9494b9c768e63
fetch "$luna/out/check/build/skeleton.png" package/build/skeleton.png 429373a34a9392c073ad1836f618d1076525e39fdf8011d40269aa3a40ea6182
fetch "$luna/out/check/build/skeleton.atlas" package/build/skeleton.atlas 51daed38aab7bc94b1be652fb5256c8caa6d5ece265f9ff1473d799e0d1056c5
fetch "$luna/out/check/build/skeleton.json" package/build/skeleton.json 936cd5099357cfce72fb57dcff8dba6a88f962e0ee3f3567bf65ace93bff41dd
fetch "$luna/out/rig/motion.json" package/motion.json 5f666102147aca87addb588295078c982b6b4f6d397fc986981330b23bb5f3d9
fetch "$source_frames/frames.json" package/frames.json 8c78ea5361ddd1030bccea037c2568ade221b0ad1e506631d9b68b4c64ae02de
fetch LICENSE package/LICENSE 1418540b6fcbb6a34fc816b5de6dce50ad7b5a06eedf6c584d4fa950ea8539df
fetch "$luna/config.json" source/config.json fb0d1ea616a196394735eea1681b561c616478c2df33685f8334b4d6e5cd9a70
fetch "$luna/out/rig/rig.json" source/rig.json a8270a02bf046c78cea042a2d16f975eec7630899d5a504cc5ec61166c5b124e
fetch "$luna/out/check/check.json" source/check.json af2b1da8a5198e6bab29791795659ae993a4eee30ddd90824e02672a94d064f7
fetch family/accepted-inputs.json source/accepted-inputs.json 2c611e9fd8f0951160378fb688a7f962ca07b6ce73faf6fd2546d5fc5f432cb2
fetch family/tools/outline-field-islands/package.json source/upstream-toolchain.json 480a8a718f7a8ca95607fd31edbd68dc504bab3e23cf701cb877080a09e68964

jq -e '.PASS == true and .gate_spine_html_green == true' source/check.json >/dev/null
jq -e '.toolchain["rig-c"] == "2.68.0"' source/accepted-inputs.json >/dev/null
jq -e '.dependencies["rig-c"] == "2.68.0"' source/upstream-toolchain.json >/dev/null
jq -e '.spec == "rigc-compiled/3" and [.pages[].name] == ["skeleton.png"] and
  [.animations[] | {name, duration}] == [{name: "idle", duration: (40/12)}]' \
  package/build/skeleton.model.json >/dev/null
jq -e '.spec == "rigc-frames/1" and .viewport.pixelWidth == 222 and .viewport.pixelHeight == 640 and
  [.sets[] | [.animation, .fps, .stride, .written]] == [["idle", 12, 1, 41]] and
  ((.sets[0].duration - (40/12)) | fabs) < 0.000000001' package/frames.json >/dev/null

frame_requests=()
for ((frame=0; frame<=40; frame++)); do
  printf -v name 'f%04d.png' "$frame"
  frame_requests+=(--url "$base/$source_frames/idle/$name" --output "source/idle/$name")
done
curl --fail --fail-early --silent --show-error --location --retry 2 \
  --parallel --parallel-max 8 "${frame_requests[@]}"
frames_index_sha=cfb16b8aa28887c683a60d7f1cceca4fb699f902bbb46d487cfef44b3de5cc55
(cd source/idle && sha256sum f*.png) > source/idle-frames.sha256
verify_sha source/idle-frames.sha256 "$frames_index_sha"

jq -n --arg revision "$commit" '{
  schema: "rig-review/1", id: "luna-idle-1306", title: "Luna idle", revision: $revision,
  model: "build/skeleton.model.json", motion: "motion.json", frames: "frames.json",
  animations: [{id: "idle", label: "Idle"}], authoring: [{label: "Source license", path: "LICENSE"}]
}' > package/review.json

reference=null
if [[ $sources_only == false ]]; then
  # Repeat each 12 fps producer image for five 60 fps samples up to the terminal
  # image. Include that image once so media duration clears the rig's exact end.
  "$ffmpeg" -nostdin -v error -framerate 12 -start_number 0 -i 'source/idle/f%04d.png' \
    -vf 'fps=60' -frames:v 201 -an -c:v libx264 -preset ultrafast -threads 1 \
    -pix_fmt yuv420p -g 60 -bf 0 -video_track_timescale 60000 -movflags +faststart reference.mp4
  "$ffprobe" -v error -select_streams v:0 -show_entries \
    stream=codec_name,width,height,avg_frame_rate,start_time,duration,nb_frames \
    -of json reference.mp4 > source/reference-probe.json
  jq -e '.streams == [.streams[0]] and (.streams[0] |
    .codec_name == "h264" and .width == 222 and .height == 640 and
    .avg_frame_rate == "60/1" and (.start_time | tonumber) == 0 and
    (.nb_frames | tonumber) == 201 and (((.duration | tonumber) - (201/60)) | fabs) < 0.000001)' \
    source/reference-probe.json >/dev/null
  video_sha=$(sha256sum reference.mp4)
  ffmpeg_version=$("$ffmpeg" -version)
  ffprobe_version=$("$ffprobe" -version)
  reference=$(jq -cn --arg sha "${video_sha%% *}" \
    --arg ffmpeg "${ffmpeg_version%%$'\n'*}" --arg ffprobe "${ffprobe_version%%$'\n'*}" \
    --slurpfile probe source/reference-probe.json '{
      path: "reference.mp4", sha256: $sha, kind: "transcode of published idle frames",
      ffmpeg: $ffmpeg, ffprobe: $ffprobe, stream: $probe[0].streams[0]
    }')
fi

jq -n --arg commit "$commit" --arg framesPath "$source_frames/idle" \
  --arg framesIndexSha "$frames_index_sha" --argjson reference "$reference" \
  --rawfile files source/files.tsv '{
  issue: 1306, historicalIssue: "https://github.com/rig-c/review/issues/356",
  historicalPR: "https://github.com/rig-c/review/pull/361",
  historicalIdentity: "Latest family/luna/out commit before #361 merged. #361 did not report a model hash.",
  repository: "https://github.com/rig-c/examples", commit: $commit, animation: "idle",
  compiler: {package: "rig-c", version: "2.68.0", evidence: "pinned examples acceptance and toolchain records",
    action: "reused committed build bytes"},
  files: ($files | split("\n") | map(select(length > 0) | split("\t") |
    {source: .[0], path: .[1], sha256: .[2]})),
  referenceImages: {source: $framesPath, hashIndex: "source/idle-frames.sha256", hashIndexSha256: $framesIndexSha,
    fps: 12, count: 41},
  reference: $reference
}' > provenance.json

printf 'fixture=%s/package/review.json\nprovenance=%s/provenance.json\n' "$out" "$out"
if [[ $sources_only == false ]]; then
  printf 'reference=%s/reference.mp4\n' "$out"
fi
