#!/bin/bash
set -euo pipefail

LOG_FILE="$HOME/Library/Logs/Video Downloadest/native-host.log"

if [[ ! -f "$LOG_FILE" ]]; then
  echo "No Native Messaging host log exists yet: $LOG_FILE" >&2
  echo "Connect the extension to the host first, then run this script again." >&2
  exit 1
fi

exec tail -n 100 -f "$LOG_FILE"
