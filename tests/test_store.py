"""SessionStore — transcripts that outlive the process.

Everything used to live in module-level dicts, so restarting the backend threw away
every transcript and summary. That also broke the OpenClaw skill's whole premise of
asking about a meeting after the fact.
"""

from __future__ import annotations

import threading

import pytest

from backend.incremental import Segment
from backend.models import Note, Session
from backend.store import SessionStore


@pytest.fixture
def store(tmp_path):
    s = SessionStore(tmp_path / "louro.db")
    yield s
    s.close()


def make_session(session_id="20260731-090000", **overrides) -> Session:
    session = Session(session_id=session_id, file=f"{session_id}.webm")
    session.chunks = 12
    session.audio_bytes = 40960
    session.status = "stopped"
    session.stopped_at = "2026-07-31T09:412:00"
    session.transcript_segments = 3
    session.language = "ko"
    session.duration_sec = 128.5
    session.title = "Weekly sync"
    session.meeting_code = "abc-defg-hij"
    for key, value in overrides.items():
        setattr(session, key, value)
    return session


def test_a_fresh_store_has_no_sessions(store):
    assert store.load_sessions() == {}


def test_session_round_trips_every_field(store):
    original = make_session()

    store.save_session(original)
    loaded = store.load_sessions()["20260731-090000"]

    assert loaded.to_dict() == original.to_dict()


def test_saving_the_same_session_updates_it(store):
    session = make_session()
    store.save_session(session)

    session.status = "stopped"
    session.transcript_segments = 99
    store.save_session(session)

    sessions = store.load_sessions()
    assert len(sessions) == 1
    assert sessions["20260731-090000"].transcript_segments == 99


def test_segments_come_back_in_the_order_they_were_added(store):
    store.save_session(make_session("s1"))
    store.add_segments("s1", [Segment(text="first", start=0.0, end=1.0)])
    store.add_segments(
        "s1",
        [Segment(text="second", start=1.0, end=2.0), Segment(text="third", start=2.0, end=3.0)],
    )

    assert [s.text for s in store.load_segments("s1")] == ["first", "second", "third"]


def test_segment_fields_survive_including_speaker(store):
    store.save_session(make_session("s1"))
    store.add_segments(
        "s1", [Segment(text="hello", start=1.5, end=2.25, speaker="A", timestamp=1234.5)]
    )

    loaded = store.load_segments("s1")[0]

    assert loaded.text == "hello"
    assert loaded.start == pytest.approx(1.5)
    assert loaded.end == pytest.approx(2.25)
    assert loaded.speaker == "A"
    assert loaded.timestamp == pytest.approx(1234.5)


def test_segments_do_not_leak_between_sessions(store):
    store.save_session(make_session("s1"))
    store.save_session(make_session("s2"))
    store.add_segments("s1", [Segment(text="mine", start=0.0, end=1.0)])
    store.add_segments("s2", [Segment(text="yours", start=0.0, end=1.0)])

    assert [s.text for s in store.load_segments("s1")] == ["mine"]
    assert [s.text for s in store.load_segments("s2")] == ["yours"]


def test_unknown_session_has_no_segments(store):
    assert store.load_segments("never-happened") == []


def test_adding_no_segments_is_harmless(store):
    store.save_session(make_session("s1"))

    store.add_segments("s1", [])

    assert store.load_segments("s1") == []


def test_everything_survives_reopening_the_database(tmp_path):
    """The actual point: restarting the backend must not lose a meeting."""
    path = tmp_path / "louro.db"
    first = SessionStore(path)
    first.save_session(make_session("s1"))
    first.add_segments("s1", [Segment(text="we decided to ship", start=0.0, end=2.0)])
    first.add_note("s1", Note(at_sec=1.0, text="shipped"))
    first.close()

    reopened = SessionStore(path)
    try:
        assert "s1" in reopened.load_sessions()
        assert [s.text for s in reopened.load_segments("s1")] == ["we decided to ship"]
        assert [n.text for n in reopened.load_notes("s1")] == ["shipped"]
    finally:
        reopened.close()


def test_writes_from_several_threads_all_land(store):
    """Segments are written from the transcription worker, not the event loop thread."""
    store.save_session(make_session("s1"))

    def write(index: int):
        store.add_segments(
            "s1", [Segment(text=f"line {index}", start=float(index), end=index + 1.0)]
        )

    threads = [threading.Thread(target=write, args=(i,)) for i in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(store.load_segments("s1")) == 20


def test_reopening_an_existing_database_does_not_wipe_it(tmp_path):
    path = tmp_path / "louro.db"
    first = SessionStore(path)
    first.save_session(make_session("s1"))
    first.close()

    second = SessionStore(path)
    second.save_session(make_session("s2"))
    try:
        assert set(second.load_sessions()) == {"s1", "s2"}
    finally:
        second.close()


def test_data_dir_can_be_moved_out_of_the_checkout(monkeypatch, tmp_path):
    from backend.store import default_data_dir

    monkeypatch.setenv("LOURO_DATA_DIR", str(tmp_path / "data"))
    assert default_data_dir() == tmp_path / "data"

    monkeypatch.delenv("LOURO_DATA_DIR")
    assert default_data_dir().name == "recordings"


def test_a_database_from_before_meeting_titles_gains_the_columns(tmp_path):
    import sqlite3

    path = tmp_path / "old.db"
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE sessions (session_id TEXT PRIMARY KEY, chunks INTEGER NOT NULL DEFAULT 0,"
        " audio_bytes INTEGER NOT NULL DEFAULT 0, started_at TEXT, stopped_at TEXT, status TEXT,"
        " file TEXT, transcript_segments INTEGER NOT NULL DEFAULT 0, language TEXT,"
        " duration_sec REAL NOT NULL DEFAULT 0, error TEXT)"
    )
    conn.execute("INSERT INTO sessions (session_id, status) VALUES ('old', 'stopped')")
    conn.commit()
    conn.close()

    store = SessionStore(path)
    try:
        assert store.load_sessions()["old"].title is None
        store.save_session(make_session("new"))
        assert store.load_sessions()["new"].title == "Weekly sync"
    finally:
        store.close()


def test_deleting_a_session_removes_its_transcript_and_notes(store):
    store.save_session(make_session("gone"))
    store.save_session(make_session("kept"))
    store.add_segments("gone", [Segment(text="a", start=0.0, end=1.0)])
    store.add_segments("kept", [Segment(text="b", start=0.0, end=1.0)])
    store.add_note("gone", Note(at_sec=0.5, text="x"))

    store.delete_session("gone")

    assert set(store.load_sessions()) == {"kept"}
    assert store.load_segments("gone") == []
    assert store.load_notes("gone") == []
    assert len(store.load_segments("kept")) == 1


def test_notes_come_back_in_time_order_and_go_with_their_session(store):
    store.save_session(make_session("n"))
    store.add_note("n", Note(at_sec=90.0, text="decision: ship friday"))
    store.add_note("n", Note(at_sec=12.5))
    store.add_note("other", Note(at_sec=1.0, text="not mine"))

    assert [(n.at_sec, n.text) for n in store.load_notes("n")] == [
        (12.5, ""),
        (90.0, "decision: ship friday"),
    ]
    store.delete_session("n")
    assert store.load_notes("n") == []
