"""Transcripts and notes must outlive the backend process.

Entering the TestClient context runs the app's startup, so leaving and re-entering it
is a genuine restart: in-memory state is dropped and everything has to come back from
disk. Without this the OpenClaw skill cannot answer "summarise my last meeting".
"""
from __future__ import annotations

import time
from dataclasses import dataclass

import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from .test_decoder import make_webm_opus


@dataclass
class RawSeg:
    start: float
    end: float
    text: str


def stub_factory(language=None):
    def transcribe(audio):
        return [RawSeg(0.0, 0.5, "we agreed to ship on friday")]  # ends at a pause, so it is final

    return transcribe


@pytest.fixture
def wired(monkeypatch, tmp_path):
    """Point the app at a temp recordings dir and database."""
    monkeypatch.setattr(app_module, "_make_transcribe_fn", stub_factory)
    monkeypatch.setattr(app_module, "RECORDINGS_DIR", tmp_path)
    monkeypatch.setattr(app_module, "DB_PATH", tmp_path / "ghostmeet.db")
    return tmp_path


def wait_until(check, timeout: float = 10.0, interval: float = 0.02):
    """Poll `check` until it returns something truthy or `timeout` seconds pass.

    Bounded by time, not by a number of polls: a fixed count of tight polls is a
    deadline that shrinks as the machine gets faster and fails when it is busy.
    """
    deadline = time.monotonic() + timeout
    while True:
        result = check()
        if result or time.monotonic() >= deadline:
            return result
        time.sleep(interval)


@pytest.fixture(scope="module")
def webm() -> bytes:
    return make_webm_opus(seconds=2.0)


def stream(client, webm: bytes, session_id: str) -> None:
    with client.websocket_connect(f"/ws/audio?session={session_id}") as ws:
        ws.receive_json()
        for i in range(0, len(webm), 4096):
            ws.send_bytes(webm[i : i + 4096])
        ws.send_text("stop")
        assert ws.receive_json()["type"] == "complete"


def test_transcript_survives_a_restart(wired, webm):
    with TestClient(app_module.app) as client:
        stream(client, webm, "persisted")
        before = client.get("/api/sessions/persisted/transcript").json()

    with TestClient(app_module.app) as client:
        after = client.get("/api/sessions/persisted/transcript").json()

    assert before["segment_count"] >= 1
    assert after["segment_count"] == before["segment_count"]
    assert after["full_text"] == before["full_text"]
    assert "ship on friday" in after["full_text"]


def test_session_list_survives_a_restart(wired, webm):
    with TestClient(app_module.app) as client:
        stream(client, webm, "persisted")

    with TestClient(app_module.app) as client:
        body = client.get("/api/sessions").json()

    assert "persisted" in body["sessions"]
    session = body["sessions"]["persisted"]
    assert session["status"] == "stopped"
    assert session["audio_bytes"] == len(webm)
    assert session["duration_sec"] > 1.0


def test_segments_are_stored_with_their_speaker_slot(wired, webm):
    with TestClient(app_module.app) as client:
        stream(client, webm, "persisted")

    with TestClient(app_module.app) as client:
        segments = client.get("/api/sessions/persisted/transcript").json()["segments"]

    assert segments[0]["speaker"] is None
    assert segments[0]["end"] > segments[0]["start"]


def test_notes_survive_a_restart(wired, webm):
    with TestClient(app_module.app) as client:
        with client.websocket_connect("/ws/audio?session=persisted") as ws:
            ws.receive_json()
            client.post("/api/sessions/persisted/notes", json={"text": "ship on friday"})
            ws.send_bytes(webm)
            ws.send_text("stop")
            ws.receive_json()

    with TestClient(app_module.app) as client:
        notes = client.get("/api/sessions/persisted/notes").json()["notes"]

    assert [n["text"] for n in notes] == ["ship on friday"]


def test_segments_are_written_during_the_meeting_not_only_at_the_end(wired, webm, monkeypatch):
    """A crash four hours in should not cost the whole transcript."""
    monkeypatch.setattr(app_module, "CHUNK_INTERVAL", 0.05)

    with TestClient(app_module.app) as client:
        with client.websocket_connect("/ws/audio?session=live") as ws:
            ws.receive_json()
            for i in range(0, len(webm), 4096):
                ws.send_bytes(webm[i : i + 4096])

            stored = wait_until(lambda: app_module.store.load_segments("live"))

            assert stored, "nothing was persisted while the session was still open"
            ws.send_text("stop")
            ws.receive_json()


def test_unknown_session_is_still_a_404_after_a_restart(wired):
    with TestClient(app_module.app) as client:
        assert client.get("/api/sessions/never-existed/transcript").status_code == 404
        assert client.get("/api/sessions/never-existed/notes").status_code == 404


def test_a_live_session_is_served_from_memory_not_the_database(wired, webm, monkeypatch):
    """While a meeting runs, captions come from the pipeline that is producing them."""
    monkeypatch.setattr(app_module, "CHUNK_INTERVAL", 0.05)

    with TestClient(app_module.app) as client:
        with client.websocket_connect("/ws/audio?session=live") as ws:
            ws.receive_json()
            for i in range(0, len(webm), 4096):
                ws.send_bytes(webm[i : i + 4096])

            count = wait_until(
                lambda: client.get("/api/sessions/live/transcript").json()["segment_count"]
            )

            assert count >= 1
            ws.send_text("stop")
            ws.receive_json()
