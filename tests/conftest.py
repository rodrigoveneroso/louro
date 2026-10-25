"""Shared test setup.

Keeps every test off the real recordings directory. Those files are actual meeting
audio and transcripts; a test run must never read, write, or delete anything there.
"""
from __future__ import annotations

import pytest

from backend import app as app_module

_REAL_RECORDINGS = app_module.RECORDINGS_DIR
_REAL_DB = app_module.DB_PATH


@pytest.fixture(autouse=True)
def isolate_storage(monkeypatch, tmp_path):
    """Redirect the app's storage at a temp directory for the duration of each test."""
    recordings = tmp_path / "recordings"
    recordings.mkdir(exist_ok=True)
    monkeypatch.setattr(app_module, "RECORDINGS_DIR", recordings)
    monkeypatch.setattr(app_module, "DB_PATH", recordings / "louro.db")
    monkeypatch.setenv("LOURO_EXPORT_DIR", str(tmp_path / "export"))
    # the stub recordings are a couple of seconds long, so keep everything; tests about
    # dropping short captures set their own minimum
    monkeypatch.setenv("LOURO_MIN_DURATION_SEC", "0")
    # a developer's own vocabulary must not leak into the tests
    monkeypatch.delenv("LOURO_VOCABULARY", raising=False)
    monkeypatch.delenv("LOURO_VOCABULARY_FILE", raising=False)
    monkeypatch.delenv("LOURO_FINAL_MODEL", raising=False)
    monkeypatch.delenv("LOURO_ON_EXPORT", raising=False)
    # Starlette's TestClient calls itself "testserver"
    monkeypatch.setattr(app_module, "ALLOWED_HOSTS", app_module.ALLOWED_HOSTS | {"testserver"})
    # captions on the live interval, watched or not, unless a test says otherwise
    monkeypatch.setattr(app_module, "IDLE_INTERVAL", 0.0)
    # tests never load a real Whisper model
    monkeypatch.setenv("LOURO_PRELOAD", "0")
    yield
    assert app_module.RECORDINGS_DIR != _REAL_RECORDINGS
    assert app_module.DB_PATH != _REAL_DB
