#!/usr/bin/env bash
# Stops the Louro backend, whether systemd or start.sh started it.
PID_FILE="${XDG_RUNTIME_DIR:-$HOME/.cache}/louro/backend.pid"

if systemctl --user is-active louro >/dev/null 2>&1; then
  systemctl --user stop louro
  echo "Stopped the Louro service (it starts again at the next login)"
fi

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  kill "$(cat "$PID_FILE")"
  echo "Stopped Louro backend (pid $(cat "$PID_FILE"))"
elif ! systemctl --user is-enabled louro >/dev/null 2>&1; then
  echo "Louro backend was not running"
fi
rm -f "$PID_FILE"
