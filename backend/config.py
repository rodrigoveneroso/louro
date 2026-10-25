"""Settings read from the environment (LOURO_*) when the backend starts.

Features that are off unless configured (export folder, vocabulary, second pass,
retention, on-export hook) read their own variables in their modules.
"""
from __future__ import annotations

import os

from .store import default_data_dir

DATA_DIR = default_data_dir()
DB_PATH = DATA_DIR / "louro.db"

WHISPER_MODEL = os.environ.get("LOURO_MODEL", "base")
WHISPER_DEVICE = os.environ.get("LOURO_DEVICE", "auto")
# "auto" lets CTranslate2 pick the fastest type the hardware supports: int8 on a CPU,
# twice as fast as float32 there with the same accuracy
WHISPER_COMPUTE = os.environ.get("LOURO_COMPUTE_TYPE", "auto")
LANGUAGE = os.environ.get("LOURO_LANGUAGE") or None
# load Whisper at startup, so the first capture does not wait for it
PRELOAD = os.environ.get("LOURO_PRELOAD", "1") != "0"

# seconds between live transcription passes while someone watches the captions
CHUNK_INTERVAL = float(os.environ.get("LOURO_CHUNK_INTERVAL", "10"))
# With the live captions closed, transcribe in one batch this often instead (0: always
# live). Keeps the machine quiet during the meeting; Stop still finishes everything.
IDLE_INTERVAL = float(os.environ.get("LOURO_IDLE_INTERVAL", "300"))

PORT = int(os.environ.get("LOURO_PORT", "8877"))
# extra Host names to accept, for a deliberate exposure with LOURO_HOST
EXTRA_HOSTS = os.environ.get("LOURO_ALLOWED_HOSTS", "")


def host() -> str:
    """Loopback unless asked otherwise: the API has no authentication."""
    return os.environ.get("LOURO_HOST", "127.0.0.1")
