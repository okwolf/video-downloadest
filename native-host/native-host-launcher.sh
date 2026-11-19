#!/bin/sh
set -eu

APP_SUPPORT="$HOME/Library/Application Support/Video Downloadest"
NODE_VERSION=$(cat "$APP_SUPPORT/Node/latest-lts")
FFMPEG_VERSION=$(cat "$APP_SUPPORT/FFmpeg/latest-release")
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

export VIDEO_DOWNLOADEST_DATA_DIR="$HOME/Videos/Video Downloadest"
export FFMPEG_PATH="$APP_SUPPORT/FFmpeg/versions/$FFMPEG_VERSION/ffmpeg"
export VIDEO_DOWNLOADEST_LOG_PATH="$HOME/Library/Logs/Video Downloadest/native-host.log"
exec "$APP_SUPPORT/Node/versions/$NODE_VERSION/bin/node" "$SCRIPT_DIR/native-host.js"
