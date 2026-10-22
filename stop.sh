#!/usr/bin/env bash
# Stops the ghostmeet backend, whether systemd or start.sh started it.
PID_FILE="${XDG_RUNTIME_DIR:-$HOME/.cache}/ghostmeet/backend.pid"

if systemctl --user is-active ghostmeet >/dev/null 2>&1; then
  systemctl --user stop ghostmeet
  echo "Stopped the ghostmeet service (it starts again at the next login)"
fi

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  kill "$(cat "$PID_FILE")"
  echo "Stopped ghostmeet backend (pid $(cat "$PID_FILE"))"
elif ! systemctl --user is-enabled ghostmeet >/dev/null 2>&1; then
  echo "ghostmeet backend was not running"
fi
rm -f "$PID_FILE"
