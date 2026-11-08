#!/usr/bin/env bash
# Build the official PokeRogue (submodule pkmain/pokerogue) in offline "app" mode
# and copy the result into app/src/main/assets/web, which both the Android APK
# and the iOS app (ios/) bundle.
#
# Usage:
#   scripts/sync-pokerogue.sh            # build whatever commit the submodule points at
#   scripts/sync-pokerogue.sh v1.12.2.6  # move the submodule to an official tag/branch first
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GAME="$ROOT/pkmain/pokerogue"
WEB="$ROOT/app/src/main/assets/web"

if [ ! -f "$GAME/package.json" ]; then
  git -C "$ROOT" submodule update --init --depth 1 pkmain/pokerogue
fi

if [ "${1:-}" != "" ]; then
  git -C "$GAME" fetch --depth 1 origin "refs/tags/$1:refs/tags/$1" 2>/dev/null \
    || git -C "$GAME" fetch --depth 1 origin "$1"
  git -C "$GAME" checkout -q "$1" 2>/dev/null || git -C "$GAME" checkout -q FETCH_HEAD
fi

# assets (sprites/audio, ~800 MB) and locales are submodules of the official repo
git -C "$GAME" submodule update --init --depth 1 assets locales

cd "$GAME"
if command -v pnpm >/dev/null 2>&1; then PNPM=pnpm; else PNPM="corepack pnpm"; fi
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1
$PNPM install --frozen-lockfile
# "app" mode = official offline build: VITE_BYPASS_LOGIN=1, saves stay on the device
$PNPM build:app

# source maps and the empty test folder are not needed on the phone
find dist -name '*.map' -delete
rm -rf dist/test

mkdir -p "$WEB"
rsync -a --delete --exclude .gitkeep dist/ "$WEB/"

VERSION="$(node -p "require('./package.json').version")"
COMMIT="$(git rev-parse HEAD)"
printf '{"pokerogueVersion":"%s","pokerogueCommit":"%s"}\n' "$VERSION" "$COMMIT" > "$ROOT/pokerogue-version.json"
echo "Synced PokeRogue $VERSION ($COMMIT) into $WEB"
