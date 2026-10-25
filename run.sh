#!/usr/bin/env bash
# Runs the Louro backend in the foreground: what start.sh puts in the background and
# what the systemd service started by install.sh runs at login.
# Reads .env and the virtualenv (.venv) from this folder.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

if [ -f "$DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091  # the user's own configuration
  source "$DIR/.env"
  set +a
fi

PYTHON="$DIR/.venv/bin/python"
if [ ! -x "$PYTHON" ]; then
  echo "virtualenv not found: run ./install.sh first" >&2
  exit 1
fi

# Low priority: the meeting (Chrome, Meet's video) always comes first, and Whisper takes
# the CPU that is left. LOURO_NICE=0 runs it at normal priority.
exec nice -n "${LOURO_NICE:-10}" "$PYTHON" -m backend
