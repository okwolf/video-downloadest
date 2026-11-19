#!/bin/bash
set -euo pipefail

HOST_NAME=com.videodownloadest.host
APP_SUPPORT="$HOME/Library/Application Support/Video Downloadest"
LAUNCHER="$APP_SUPPORT/DevHost/native-host-launcher.sh"
MANIFEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/$HOST_NAME.json"

if [[ ! -f "$MANIFEST" ]]; then
  echo "No Native Messaging host registration is installed."
  exit 0
fi

if ! grep -Fq "\"path\": \"$LAUNCHER\"" "$MANIFEST"; then
  echo "The registered host is not the development launcher; leaving it unchanged." >&2
  exit 1
fi

rm -f "$MANIFEST" "$LAUNCHER"
rmdir "$APP_SUPPORT/DevHost" 2>/dev/null || true
echo "Removed the development Native Messaging host registration."
