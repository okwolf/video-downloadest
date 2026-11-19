#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
APP_VERSION="${APP_VERSION:-0.1.0}"
APP="$ROOT/dist/Video Downloadest.app"
DMG="$ROOT/dist/Video Downloadest-$APP_VERSION.dmg"
STAGING=$(mktemp -d /private/tmp/video-downloadest-dmg.XXXXXX)
trap 'rm -rf "$STAGING"' EXIT

"$ROOT/scripts/build-companion-macos.sh"
cp -R "$APP" "$STAGING/"
ln -s /Applications "$STAGING/Applications"
cat > "$STAGING/Install Guide.txt" <<'GUIDE'
Video Downloadest for macOS

1. Drag Video Downloadest.app to Applications.
2. Open it from Applications. The app downloads Node.js and FFmpeg on first launch.
3. In the app, click Copy folder path.
4. Open Chrome extensions and turn on Developer mode.
5. Choose Load unpacked. In the folder picker, press / and paste the copied path.
6. Press Return, then choose Select Folder.

Requirements: Apple Silicon Mac, macOS 13 or newer, Google Chrome, and an internet connection for first launch.
GUIDE

rm -f "$DMG"
hdiutil create -volname "Video Downloadest" -srcfolder "$STAGING" -ov -format UDZO "$DMG"

if [ -n "${DEVELOPER_ID_APPLICATION:-}" ]; then
  codesign --force --timestamp --sign "$DEVELOPER_ID_APPLICATION" "$DMG"
fi

if [ -n "${NOTARY_PROFILE:-}" ]; then
  if [ -z "${DEVELOPER_ID_APPLICATION:-}" ]; then
    echo "Set DEVELOPER_ID_APPLICATION before notarizing." >&2
    exit 1
  fi
  xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG"
fi

echo "Packaged $DMG"
if [ -z "${DEVELOPER_ID_APPLICATION:-}" ]; then
  echo "This DMG is not Developer ID signed. Set DEVELOPER_ID_APPLICATION for a signed release."
elif [ -z "${NOTARY_PROFILE:-}" ]; then
  echo "Set NOTARY_PROFILE to a Keychain profile if you want to submit and staple notarization."
fi
