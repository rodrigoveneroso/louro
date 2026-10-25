#!/usr/bin/env bash
# Starts the Louro backend in the background (local Whisper transcription).
# With the service install.sh sets up, systemd runs it; otherwise it runs under nohup.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="${XDG_RUNTIME_DIR:-$HOME/.cache}/louro"
LOG_FILE="$RUN_DIR/backend.log"
PID_FILE="$RUN_DIR/backend.pid"
PORT="${LOURO_PORT:-8877}"
mkdir -p "$RUN_DIR"

wait_until_up() {
  for _ in $(seq 1 30); do
    if curl -fs "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
      echo "backend is up on 127.0.0.1:$PORT"
      return 0
    fi
    sleep 1
  done
  echo "backend not responding yet, check $1"
  return 1
}

if systemctl --user is-enabled louro >/dev/null 2>&1; then
  systemctl --user start louro
  wait_until_up "journalctl --user -u louro"
  exit $?
fi

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Louro backend already running (pid $(cat "$PID_FILE"))"
  exit 0
fi

nohup "$DIR/run.sh" >"$LOG_FILE" 2>&1 &
echo $! >"$PID_FILE"
disown
echo "Started Louro backend (pid $!), log: $LOG_FILE"
wait_until_up "$LOG_FILE"
