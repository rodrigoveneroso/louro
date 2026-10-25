"""Shared test setup.

Keeps every test off the real recordings directory. Those files are actual meeting
audio and transcripts; a test run must never read, write, or delete anything there.
"""

from __future__ import annotations

import pytest

from backend import config, security

_REAL_RECORDINGS = config.DATA_DIR
_REAL_DB = config.DB_PATH


@pytest.fixture(autouse=True)
def isolate_storage(monkeypatch, tmp_path):
    """Redirect the app's storage at a temp directory for the duration of each test."""
    recordings = tmp_path / "recordings"
    recordings.mkdir(exist_ok=True)
    monkeypatch.setattr(config, "DATA_DIR", recordings)
    monkeypatch.setattr(config, "DB_PATH", recordings / "louro.db")
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
    monkeypatch.setattr(security, "ALLOWED_HOSTS", security.ALLOWED_HOSTS | {"testserver"})
    # captions on the live interval, watched or not, unless a test says otherwise
    monkeypatch.setattr(config, "IDLE_INTERVAL", 0.0)
    # tests never load a real Whisper model
    monkeypatch.setattr(config, "PRELOAD", False)
    yield
    assert config.DATA_DIR != _REAL_RECORDINGS
    assert config.DB_PATH != _REAL_DB
