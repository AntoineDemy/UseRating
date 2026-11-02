#!/usr/bin/env bash
# Builds one plugin zip per supported Jellyfin release line into releases/.
# Usage: ./build.sh            (needs Docker)
#        ./build.sh 10.11.0    (single target)
set -euo pipefail
cd "$(dirname "$0")"

VERSION="$(cat VERSION.txt)"
if [ $# -gt 0 ]; then TARGETS=("$@"); else TARGETS=(10.9.0 10.10.0 10.11.0 12.0.0); fi

mkdir -p releases

# Minified ratings.js, picked up by the csproj instead of the readable source.
docker run --rm -v "$PWD":/src node:22-alpine sh -c \
  "cd /tmp && npm i --silent --no-audit --no-fund esbuild@0.25 && cp /src/scripts/minify.mjs . \
   && node minify.mjs /src/Configuration/ratings.js /src/out/min/ratings.js"

for jf in "${TARGETS[@]}"; do
  out="out/$jf"
  rm -rf "$out" obj bin
  docker run --rm -v "$PWD":/src -w /src mcr.microsoft.com/dotnet/sdk:10.0 \
    dotnet build -c Release -p:JellyfinVersion="$jf" -o "/src/$out"
  zip="releases/user-ratings_${VERSION}_jellyfin-${jf}.zip"
  rm -f "$zip"
  zip -j -X "$zip" "$out/Jellyfin.Plugin.UserRatings.dll"
  if command -v md5sum >/dev/null; then sum="$(md5sum "$zip" | cut -d' ' -f1)"; else sum="$(md5 -q "$zip")"; fi
  echo "$jf $zip $sum"
done
rm -rf obj bin out/min
