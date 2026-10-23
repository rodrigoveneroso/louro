#!/usr/bin/env bash
# Runs the ghostmeet backend in the foreground: what start.sh puts in the background and
# what the systemd service started by install.sh runs at login.
# Reads .env from this folder (or the repository root) and the virtualenv at ../.venv.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

for env_file in "$DIR/.env" "$DIR/../.env"; do
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090  # the user's own configuration
    source "$env_file"
    set +a
    break
  fi
done

PYTHON="$DIR/../.venv/bin/python"
[ -x "$PYTHON" ] || PYTHON="$DIR/.venv/bin/python"
if [ ! -x "$PYTHON" ]; then
  echo "virtualenv not found: run ./install.sh first" >&2
  exit 1
fi

# Low priority: the meeting (Chrome, Meet's video) always comes first, and Whisper takes
# the CPU that is left. GHOSTMEET_NICE=0 runs it at normal priority.
exec nice -n "${GHOSTMEET_NICE:-10}" "$PYTHON" -m backend
