#!/bin/bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "$0")/.." && pwd)
NODE_BIN=${NODE_BIN:-$(command -v node || true)}
FFMPEG_BIN=${FFMPEG_PATH:-$(command -v ffmpeg || true)}
HOST_NAME=com.videodownloadest.host
EXTENSION_ID=nifpakplfpdbabogkojdegnnkkpkckpd
APP_SUPPORT="$HOME/Library/Application Support/Video Downloadest"
DEV_HOST_DIR="$APP_SUPPORT/DevHost"
LAUNCHER="$DEV_HOST_DIR/native-host-launcher.sh"
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST="$MANIFEST_DIR/$HOST_NAME.json"

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "Node.js 22 or newer is required. Set NODE_BIN to its executable path." >&2
  exit 1
fi
if [[ -z "$FFMPEG_BIN" || ! -x "$FFMPEG_BIN" ]]; then
  echo "FFmpeg is required. Set FFMPEG_PATH to its executable path." >&2
  exit 1
fi
NODE_MAJOR=$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])')
if (( NODE_MAJOR < 22 )); then
  echo "Node.js 22 or newer is required; found $NODE_MAJOR." >&2
  exit 1
fi

mkdir -p "$DEV_HOST_DIR" "$MANIFEST_DIR" "$HOME/Videos/Video Downloadest" \
  "$HOME/Library/Logs/Video Downloadest"
cat > "$LAUNCHER" <<LAUNCHER_EOF
#!/bin/sh
set -eu
export VIDEO_DOWNLOADEST_DATA_DIR=$(printf '%q' "$HOME/Videos/Video Downloadest")
export FFMPEG_PATH=$(printf '%q' "$FFMPEG_BIN")
export VIDEO_DOWNLOADEST_LOG_PATH=$(printf '%q' "$HOME/Library/Logs/Video Downloadest/native-host.log")
exec $(printf '%q' "$NODE_BIN") $(printf '%q' "$ROOT/native-host/native-host.js")
LAUNCHER_EOF
chmod 755 "$LAUNCHER"

"$NODE_BIN" -e 'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], JSON.stringify({name: process.argv[2], description: "Video Downloadest development capture host", path: process.argv[3], type: "stdio", allowed_origins: [`chrome-extension://${process.argv[4]}/`]}, null, 2));' \
  "$MANIFEST" "$HOST_NAME" "$LAUNCHER" "$EXTENSION_ID"

echo "Registered the development Native Messaging host at:"
echo "  $MANIFEST"
echo "Load or reload the unpacked extension from: $ROOT/extension"
