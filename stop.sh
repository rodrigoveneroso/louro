#!/usr/bin/env bash
# Stops the ghostmeet backend started by start.sh.
PID_FILE="${XDG_RUNTIME_DIR:-$HOME/.cache}/ghostmeet/backend.pid"

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  kill "$(cat "$PID_FILE")"
  echo "Stopped ghostmeet backend (pid $(cat "$PID_FILE"))"
else
  echo "ghostmeet backend was not running"
fi
rm -f "$PID_FILE"
