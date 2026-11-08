#!/usr/bin/env bash
# Build an unsigned (ad-hoc) PokeRogue.ipa for sideloading with AltStore / Sideloadly / TrollStore.
# Usage: ios/build-ipa.sh [output.ipa]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/build/ios/PokeRogue.ipa}"
BUILD="${BUILD_DIR:-$ROOT/build/ios}"

if [ ! -f "$ROOT/app/src/main/assets/web/index.html" ]; then
  echo "app/src/main/assets/web is empty - run scripts/sync-pokerogue.sh first" >&2
  exit 1
fi

xcodebuild \
  -project "$ROOT/ios/PokeRogue.xcodeproj" \
  -target PokeRogue \
  -configuration Release \
  -sdk iphoneos \
  -arch arm64 \
  SYMROOT="$BUILD" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  build

APP="$BUILD/Release-iphoneos/PokeRogue.app"
STAGE="$BUILD/ipa"
rm -rf "$STAGE"
mkdir -p "$STAGE/Payload"
cp -R "$APP" "$STAGE/Payload/"
# Ad-hoc signature (same as `ldid -S`): AltStore/Sideloadly re-sign it anyway, TrollStore accepts it as is.
codesign --force --sign - --timestamp=none "$STAGE/Payload/PokeRogue.app"

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
(cd "$STAGE" && zip -qry "$OUT" Payload)
echo "IPA: $OUT ($(du -h "$OUT" | cut -f1))"
