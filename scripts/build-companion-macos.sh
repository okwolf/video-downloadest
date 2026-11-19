#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
APP_VERSION="${APP_VERSION:-0.1.0}"
APP="$ROOT/dist/Video Downloadest.app"
CONTENTS="$APP/Contents"
RESOURCES="$CONTENTS/Resources"
CACHE_DIR="$ROOT/dist/module-cache"
trap 'rm -rf "$CACHE_DIR" "$ROOT/dist/AppIcon.icns" "$ROOT/dist/AppIcon.iconset" "$ROOT/dist/generate-icon"' EXIT

command -v swiftc >/dev/null || { echo "Xcode Command Line Tools are required." >&2; exit 1; }

rm -rf "$APP"
mkdir -p "$ROOT/dist/module-cache" "$CONTENTS/MacOS" "$RESOURCES/Server" "$RESOURCES/Extension"
rm -rf "$CACHE_DIR"
mkdir -p "$CACHE_DIR"
swiftc -O -target arm64-apple-macosx13.0 \
  -parse-as-library \
  -module-cache-path "$CACHE_DIR" \
  -framework AppKit -framework SwiftUI \
  "$ROOT/companion/VideoDownloadestCompanion.swift" \
  -o "$CONTENTS/MacOS/VideoDownloadestCompanion"
swiftc -O -module-cache-path "$CACHE_DIR" -framework AppKit \
  "$ROOT/companion/generate-icon.swift" -o "$ROOT/dist/generate-icon"
"$ROOT/dist/generate-icon" "$ROOT/dist/AppIcon.iconset"
sips -s format icns "$ROOT/dist/AppIcon.iconset/icon_512x512.png" \
  --out "$ROOT/dist/AppIcon.icns" >/dev/null
cp "$ROOT/dist/AppIcon.icns" "$RESOURCES/AppIcon.icns"
rm -rf "$ROOT/dist/AppIcon.iconset" "$ROOT/dist/generate-icon"

cp "$ROOT/server.js" "$ROOT/capture-store.js" "$ROOT/package.json" "$RESOURCES/Server/"
cp -R "$ROOT/node_modules" "$RESOURCES/Server/node_modules"
cp "$ROOT/manifest.json" "$ROOT/injected-script.js" "$ROOT/content-script.js" \
  "$ROOT/iframe.html" "$ROOT/iframe.js" "$RESOURCES/Extension/"

cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>VideoDownloadestCompanion</string>
  <key>CFBundleIdentifier</key><string>dev.videodownloadest.companion</string>
  <key>CFBundleName</key><string>Video Downloadest</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.video</string>
  <key>CFBundleShortVersionString</key><string>$APP_VERSION</string>
  <key>CFBundleVersion</key><string>$APP_VERSION</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AppIcon.icns</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST

if [ -n "${DEVELOPER_ID_APPLICATION:-}" ]; then
  codesign --force --deep --options runtime --timestamp --sign "$DEVELOPER_ID_APPLICATION" "$APP"
  echo "Built and signed $APP (Apple Silicon; $APP_VERSION)."
else
  codesign --force --deep --sign - "$APP"
  echo "Built $APP (Apple Silicon; $APP_VERSION; local ad hoc signature)."
fi
echo "The app downloads the latest Apple Silicon Node.js LTS on first launch."
echo "The app downloads the latest stable Apple Silicon FFmpeg build on first launch."
