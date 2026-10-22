#!/usr/bin/env bash
# Starts the ghostmeet backend in the background (local Whisper transcription).
# Reads .env from this folder (or the repository root) and the virtualenv at ../.venv.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="${XDG_RUNTIME_DIR:-$HOME/.cache}/ghostmeet"
LOG_FILE="$RUN_DIR/backend.log"
PID_FILE="$RUN_DIR/backend.pid"
mkdir -p "$RUN_DIR"

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "ghostmeet backend already running (pid $(cat "$PID_FILE"))"
  exit 0
fi

cd "$DIR"
for env_file in "$DIR/.env" "$DIR/../.env"; do
  if [ -f "$env_file" ]; then
    set -a; source "$env_file"; set +a
    break
  fi
done

PYTHON="$DIR/../.venv/bin/python"
[ -x "$PYTHON" ] || PYTHON="$DIR/.venv/bin/python"
[ -x "$PYTHON" ] || { echo "virtualenv not found: create ../.venv first (see README)"; exit 1; }

nohup "$PYTHON" -m backend > "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
disown
echo "Started ghostmeet backend (pid $!), log: $LOG_FILE"

for _ in $(seq 1 30); do
  if curl -fs "http://127.0.0.1:${GHOSTMEET_PORT:-8877}/api/health" >/dev/null 2>&1; then
    echo "backend is up on 127.0.0.1:${GHOSTMEET_PORT:-8877}"
    exit 0
  fi
  sleep 1
done
echo "backend not responding yet, check $LOG_FILE"
