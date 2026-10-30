#!/usr/bin/env bash
# Sets Louro up on this machine, from a fresh clone to a backend running at login.
#
#   ./install.sh              asks a few questions, with sensible defaults
#   ./install.sh --yes        takes every default (or the LOURO_* values in the env)
#
# Options: --no-service (no autostart), --no-model (do not download Whisper now),
#          --reconfigure (write .env again, keeping the old one as .env.bak).
#
# It never needs sudo: the virtualenv goes in .venv, the model in the Hugging Face
# cache, the service in your user's systemd. Run it again any time; it only does what is
# missing, and ./doctor.sh tells what is wrong.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$DIR/.venv"
ENV_FILE="$DIR/.env"
SERVICE_DIR="${LOURO_SYSTEMD_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user}"

ASSUME_YES=0
WITH_SERVICE=1
WITH_MODEL=1
RECONFIGURE=0
for arg in "$@"; do
  case "$arg" in
    --yes | -y) ASSUME_YES=1 ;;
    --no-service) WITH_SERVICE=0 ;;
    --no-model) WITH_MODEL=0 ;;
    --reconfigure) RECONFIGURE=1 ;;
    -h | --help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $arg (see --help)" >&2
      exit 2
      ;;
  esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok() { printf '  ✓ %s\n' "$1"; }
fail() {
  printf '  ✗ %s\n' "$1" >&2
  exit 1
}

# ask "question" default -> the answer, or the default with --yes / no terminal
ask() {
  local answer
  if [ "$ASSUME_YES" = 1 ] || [ ! -t 0 ]; then
    printf '%s\n' "$2"
    return
  fi
  read -r -p "  $1 [$2]: " answer
  printf '%s\n' "${answer:-$2}"
}

# --- Python ------------------------------------------------------------------------

step "Python"
# uv, when there is one, needs no python3-venv package and is much faster than pip
UV=$(command -v uv || command -v "$HOME/.local/bin/uv" || true)
PYTHON_BIN="${LOURO_PYTHON:-python3}"

if [ ! -x "$VENV/bin/python" ]; then
  if [ -n "$UV" ]; then
    "$UV" venv --quiet --python ">=3.10" "$VENV" || fail "uv could not create the virtualenv"
  else
    command -v "$PYTHON_BIN" >/dev/null || fail "python3 not found: install Python 3.10 or newer"
    "$PYTHON_BIN" -c 'import sys; sys.exit(sys.version_info < (3, 10))' ||
      fail "Python 3.10 or newer is needed, found $("$PYTHON_BIN" --version 2>&1)"
    if ! "$PYTHON_BIN" -m venv "$VENV" >/dev/null 2>&1; then
      rm -rf "$VENV" # never leave a half-made one behind for the next run to trust
      fail "could not create a virtualenv: install python3-venv (Debian/Ubuntu) or uv (https://docs.astral.sh/uv/)"
    fi
  fi
  ok "virtualenv created in $(cd "$VENV" && pwd)"
else
  ok "virtualenv in $(cd "$VENV" && pwd)"
fi
"$VENV/bin/python" -c 'import sys; sys.exit(sys.version_info < (3, 10))' ||
  fail "the virtualenv's Python is older than 3.10: remove $VENV and run again"
ok "$("$VENV/bin/python" --version 2>&1)"

if [ -n "$UV" ]; then
  "$UV" pip install --quiet --python "$VENV/bin/python" -r "$DIR/requirements.txt"
else
  "$VENV/bin/python" -m pip install --quiet --upgrade pip
  "$VENV/bin/python" -m pip install --quiet -r "$DIR/requirements.txt"
fi
ok "dependencies installed"

# --- configuration -----------------------------------------------------------------

step "Configuration"
if [ -f "$ENV_FILE" ] && [ "$RECONFIGURE" = 0 ]; then
  ok "keeping your $ENV_FILE (./install.sh --reconfigure writes a new one)"
else
  language=$(ask "Language of your meetings (pt, en, es…; empty = detect)" "${LOURO_LANGUAGE:-pt}")
  model=$(ask "Whisper model (base = fastest, small = more accurate)" "${LOURO_MODEL:-small}")
  export_dir=$(ask "Folder for a markdown copy of each meeting (empty = none)" \
    "${LOURO_EXPORT_DIR:-$HOME/louro/transcripts}")
  vocabulary=$(ask "Vocabulary file, one name or term per line (empty = none)" \
    "${LOURO_VOCABULARY_FILE:-}")

  if [ -f "$ENV_FILE" ]; then
    cp "$ENV_FILE" "$ENV_FILE.bak"
    ok "previous configuration saved as $ENV_FILE.bak"
  fi
  # run.sh sources this file, so each value is shell-quoted: a folder with a space in its
  # name must not turn into a command. "~" is expanded first, since quoting keeps it literal.
  {
    printf '# Written by install.sh. Every setting is explained in .env.example.\n'
    printf 'LOURO_LANGUAGE=%q\n' "$language"
    printf 'LOURO_MODEL=%q\n' "$model"
    printf 'LOURO_COMPUTE_TYPE=auto\n'
    printf 'LOURO_EXPORT_DIR=%q\n' "${export_dir/#\~/$HOME}"
    printf 'LOURO_VOCABULARY_FILE=%q\n' "${vocabulary/#\~/$HOME}"
  } >"$ENV_FILE"
  if [ -n "$export_dir" ]; then
    mkdir -p "${export_dir/#\~/$HOME}"
  fi
  if [ -n "$vocabulary" ] && [ ! -e "${vocabulary/#\~/$HOME}" ]; then
    mkdir -p "$(dirname "${vocabulary/#\~/$HOME}")"
    printf '# One name, acronym or term per line.\n' >"${vocabulary/#\~/$HOME}"
    ok "created $vocabulary, add your words there"
  fi
  ok "wrote $ENV_FILE"
fi

# the model the configuration asks for, read the same way the backend reads it
# shellcheck disable=SC1090  # the user's own configuration
MODEL=$(set -a && source "$ENV_FILE" >/dev/null 2>&1 && printf '%s' "${LOURO_MODEL:-base}")

# --- Whisper model -----------------------------------------------------------------

if [ "$WITH_MODEL" = 1 ]; then
  step "Whisper model ($MODEL)"
  "$VENV/bin/python" - "$MODEL" <<'PY' 2>/dev/null || fail "could not download the model $MODEL"
import sys
from faster_whisper import WhisperModel

WhisperModel(sys.argv[1], device="cpu", compute_type="auto")
PY
  ok "downloaded and checked, so the first meeting does not wait for it"
fi

# --- autostart -----------------------------------------------------------------------

if [ "$WITH_SERVICE" = 1 ]; then
  step "Start at login"
  if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
    "$DIR/stop.sh" >/dev/null 2>&1 || true # a backend from start.sh would hold the port
    mkdir -p "$SERVICE_DIR"
    cat >"$SERVICE_DIR/louro.service" <<EOF
[Unit]
Description=Louro backend (local meeting transcription)
Documentation=https://github.com/rodrigoveneroso/louro

[Service]
ExecStart=$DIR/run.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    if systemctl --user enable --now louro >/dev/null 2>&1; then
      ok "the backend now starts at login (systemctl --user status louro)"
    else
      fail "could not start the service: see systemctl --user status louro"
    fi
  else
    ok "no systemd user session here: start the backend with ./start.sh"
  fi
fi

# --- the extension ---------------------------------------------------------------------

step "Chrome extension"
cat <<EOF
  1. Open chrome://extensions and turn on Developer mode (top right)
  2. Click "Load unpacked" and choose:
       $DIR/extension
  3. Pin the 🦜 Louro icon. The first recording asks for your microphone once.
EOF

step "Checking everything"
"$DIR/doctor.sh" || true
