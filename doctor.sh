#!/usr/bin/env bash
# Says what is wrong with this ghostmeet setup, and how to fix it.
#
#   ./doctor.sh        exit status 0 when everything is fine, 1 otherwise
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="$DIR/../.venv/bin/python"
problems=0

ok() { printf '  ✓ %s\n' "$1"; }
warn() { printf '  ! %s\n' "$1"; }
bad() {
  printf '  ✗ %s\n      → %s\n' "$1" "$2"
  problems=$((problems + 1))
}

echo "ghostmeet doctor"

# --- installation ----------------------------------------------------------------------

if [ -x "$PYTHON" ] && "$PYTHON" -c 'import fastapi, faster_whisper, av' 2>/dev/null; then
  ok "virtualenv with the dependencies ($("$PYTHON" --version 2>&1))"
else
  bad "virtualenv or dependencies missing" "./install.sh"
fi

ENV_FILE=""
for candidate in "$DIR/.env" "$DIR/../.env"; do
  if [ -f "$candidate" ]; then
    ENV_FILE="$candidate"
    break
  fi
done
if [ -n "$ENV_FILE" ]; then
  # read it the way run.sh does, so what is checked is what the backend gets
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE" >/dev/null 2>&1
  set +a
  ok "configuration in $ENV_FILE"
else
  warn "no .env: running on defaults (./install.sh --reconfigure writes one)"
fi

MODEL="${GHOSTMEET_MODEL:-base}"
PORT="${GHOSTMEET_PORT:-8877}"
expand() { printf '%s' "${1/#\~/$HOME}"; }

if [ -z "${GHOSTMEET_LANGUAGE:-}" ]; then
  warn "GHOSTMEET_LANGUAGE is not set: Whisper guesses the language of every meeting"
fi

if [ -x "$PYTHON" ] && "$PYTHON" - "$MODEL" 2>/dev/null <<'PY'; then
import sys
from faster_whisper import WhisperModel

WhisperModel(sys.argv[1], device="cpu", compute_type="auto", local_files_only=True)
PY
  ok "Whisper model '$MODEL' is downloaded"
else
  bad "Whisper model '$MODEL' is not downloaded" "./install.sh (or it downloads on the first meeting)"
fi

if [ -n "${GHOSTMEET_EXPORT_DIR:-}" ]; then
  export_dir=$(expand "$GHOSTMEET_EXPORT_DIR")
  if [ -d "$export_dir" ] && [ -w "$export_dir" ]; then
    ok "transcripts are exported to $export_dir"
  else
    bad "the export folder $export_dir does not exist or is not writable" "mkdir -p \"$export_dir\""
  fi
else
  warn "GHOSTMEET_EXPORT_DIR is not set: no markdown copy of the meetings"
fi

if [ -n "${GHOSTMEET_VOCABULARY_FILE:-}" ]; then
  vocabulary=$(expand "$GHOSTMEET_VOCABULARY_FILE")
  if [ -r "$vocabulary" ]; then
    terms=$(grep -cvE '^[[:space:]]*(#|$)' "$vocabulary")
    ok "vocabulary: $terms terms in $vocabulary"
  else
    bad "the vocabulary file $vocabulary cannot be read" "create it, one term per line"
  fi
fi

# --- running -----------------------------------------------------------------------------

if systemctl --user is-enabled ghostmeet >/dev/null 2>&1; then
  if systemctl --user is-active ghostmeet >/dev/null 2>&1; then
    ok "the service starts the backend at login, and it is running"
  else
    bad "the service is installed but not running" "journalctl --user -u ghostmeet -n 50"
  fi
else
  warn "no autostart: run ./start.sh after each login (./install.sh sets up the service)"
fi

if health=$(curl -fs "http://127.0.0.1:$PORT/api/health" 2>/dev/null); then
  if printf '%s' "$health" | grep -q '"model_ready":true'; then
    ok "backend answering on 127.0.0.1:$PORT, Whisper loaded"
  else
    ok "backend answering on 127.0.0.1:$PORT (Whisper still loading)"
  fi
else
  bad "no backend on 127.0.0.1:$PORT" "./start.sh"
fi

# --- the extension -----------------------------------------------------------------------

version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$DIR/extension/manifest.json")
echo "  · the extension cannot be checked from here: chrome://extensions should show"
echo "    ghostmeet $version, loaded from $DIR/extension"

echo
if [ "$problems" = 0 ]; then
  echo "All good."
else
  echo "$problems problem(s) found."
fi
[ "$problems" = 0 ]
