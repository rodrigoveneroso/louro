"""SQLite persistence for sessions, transcripts and notes.

Segments are written as they are committed rather than at the end, so a crash part way
through a long meeting loses at most the transcript of the newest window instead of the
whole transcript: up to `window_sec` of speech held back or not yet committed, plus the
audio that arrived since the last pass. The audio itself is already on disk (PcmStore).
"""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
from collections.abc import Sequence
from pathlib import Path

from .incremental import Segment
from .models import ChatMessage, Note, Session

logger = logging.getLogger(__name__)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    session_id          TEXT PRIMARY KEY,
    chunks              INTEGER NOT NULL DEFAULT 0,
    audio_bytes         INTEGER NOT NULL DEFAULT 0,
    started_at          TEXT,
    stopped_at          TEXT,
    status              TEXT,
    file                TEXT,
    transcript_segments INTEGER NOT NULL DEFAULT 0,
    language            TEXT,
    duration_sec        REAL NOT NULL DEFAULT 0,
    error               TEXT,
    title               TEXT,
    meeting_code        TEXT
);

CREATE TABLE IF NOT EXISTS segments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    text       TEXT NOT NULL,
    start_sec  REAL NOT NULL,
    end_sec    REAL NOT NULL,
    speaker    TEXT,
    created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_segments_session ON segments(session_id, id);

CREATE TABLE IF NOT EXISTS notes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    at_sec     REAL NOT NULL,
    text       TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_notes_session ON notes(session_id, at_sec);

CREATE TABLE IF NOT EXISTS chat_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    client_id  TEXT NOT NULL,
    author     TEXT NOT NULL,
    text       TEXT NOT NULL,
    at_sec     REAL NOT NULL,
    historical INTEGER NOT NULL DEFAULT 0,
    UNIQUE(session_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_session
    ON chat_messages(session_id, at_sec, id);

"""


# columns added after the first release: databases created before them gain them on open
_ADDED_COLUMNS = {"sessions": [("title", "TEXT"), ("meeting_code", "TEXT")]}


def default_data_dir() -> Path:
    """Where the database and per-session files live: LOURO_DATA_DIR, else
    `recordings/` next to the backend package."""
    configured = os.environ.get("LOURO_DATA_DIR", "").strip()
    if configured:
        return Path(configured).expanduser()
    return Path(__file__).resolve().parent.parent / "recordings"


class SessionStore:
    """Durable home for everything the API serves after a meeting ends."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # the transcription worker writes from its own thread, the API reads from the
        # event loop thread, so the connection is shared under an explicit lock
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            self._conn.executescript(_SCHEMA)
            self._add_missing_columns()
            self._conn.commit()

    def _add_missing_columns(self) -> None:
        for table, columns in _ADDED_COLUMNS.items():
            existing = {row["name"] for row in self._conn.execute(f"PRAGMA table_info({table})")}
            for name, kind in columns:
                if name not in existing:
                    self._conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {kind}")

    def save_session(self, session: Session) -> None:
        with self._lock:
            self._conn.execute(
                """
                INSERT INTO sessions (session_id, chunks, audio_bytes, started_at,
                                      stopped_at, status, file, transcript_segments,
                                      language, duration_sec, error, title, meeting_code)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    chunks=excluded.chunks,
                    audio_bytes=excluded.audio_bytes,
                    started_at=excluded.started_at,
                    stopped_at=excluded.stopped_at,
                    status=excluded.status,
                    file=excluded.file,
                    transcript_segments=excluded.transcript_segments,
                    language=excluded.language,
                    duration_sec=excluded.duration_sec,
                    error=excluded.error,
                    title=excluded.title,
                    meeting_code=excluded.meeting_code
                """,
                (
                    session.session_id,
                    session.chunks,
                    session.audio_bytes,
                    session.started_at,
                    session.stopped_at,
                    session.status,
                    session.file,
                    session.transcript_segments,
                    session.language,
                    session.duration_sec,
                    session.error,
                    session.title,
                    session.meeting_code,
                ),
            )
            self._conn.commit()

    def add_segments(self, session_id: str, segments: Sequence[Segment]) -> None:
        if not segments:
            return
        with self._lock:
            self._conn.executemany(
                """
                INSERT INTO segments (session_id, text, start_sec, end_sec, speaker, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                [(session_id, s.text, s.start, s.end, s.speaker, s.timestamp) for s in segments],
            )
            self._conn.commit()

    def load_sessions(self) -> dict[str, Session]:
        with self._lock:
            rows = self._conn.execute("SELECT * FROM sessions ORDER BY started_at").fetchall()
        return {row["session_id"]: _row_to_session(row) for row in rows}

    def load_segments(self, session_id: str) -> list[Segment]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM segments WHERE session_id = ? ORDER BY id", (session_id,)
            ).fetchall()
        return [
            Segment(
                text=row["text"],
                start=row["start_sec"],
                end=row["end_sec"],
                speaker=row["speaker"],
                timestamp=row["created_at"],
            )
            for row in rows
        ]

    def replace_segments(self, session_id: str, segments: Sequence[Segment]) -> None:
        """Swap a session's whole transcript for another, in one transaction: a reader
        sees either the old one or the new one, never a mix or nothing."""
        with self._lock, self._conn:
            self._conn.execute("DELETE FROM segments WHERE session_id = ?", (session_id,))
            self._conn.executemany(
                """
                    INSERT INTO segments (session_id, text, start_sec, end_sec, speaker, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                [(session_id, s.text, s.start, s.end, s.speaker, s.timestamp) for s in segments],
            )

    def add_note(self, session_id: str, note: Note) -> int:
        with self._lock:
            cursor = self._conn.execute(
                "INSERT INTO notes (session_id, at_sec, text) VALUES (?, ?, ?)",
                (session_id, note.at_sec, note.text),
            )
            self._conn.commit()
            return int(cursor.lastrowid)

    def load_notes(self, session_id: str) -> list[Note]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT at_sec, text FROM notes WHERE session_id = ? ORDER BY at_sec, id",
                (session_id,),
            ).fetchall()
        return [Note(at_sec=row["at_sec"], text=row["text"]) for row in rows]

    def load_timeline_notes(self, session_id: str) -> list[dict[str, object]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT id, at_sec, text FROM notes WHERE session_id = ? ORDER BY at_sec, id",
                (session_id,),
            ).fetchall()
        return [{"id": row["id"], "at_sec": row["at_sec"], "text": row["text"]} for row in rows]

    def add_chat_messages(self, messages: Sequence[ChatMessage]) -> list[ChatMessage]:
        """Insert new messages in input order and ignore retries for the session."""
        inserted: list[ChatMessage] = []
        if not messages:
            return inserted
        with self._lock:
            for message in messages:
                cursor = self._conn.execute(
                    """
                    INSERT OR IGNORE INTO chat_messages
                        (session_id, client_id, author, text, at_sec, historical)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        message.session_id,
                        message.client_id,
                        message.author,
                        message.text,
                        message.at_sec,
                        int(message.historical),
                    ),
                )
                if cursor.rowcount == 1:
                    inserted.append(
                        ChatMessage(
                            id=cursor.lastrowid,
                            session_id=message.session_id,
                            client_id=message.client_id,
                            author=message.author,
                            text=message.text,
                            at_sec=message.at_sec,
                            historical=message.historical,
                        )
                    )
            self._conn.commit()
        return inserted

    def load_chat_messages(self, session_id: str) -> list[ChatMessage]:
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT id, session_id, client_id, author, text, at_sec, historical
                FROM chat_messages
                WHERE session_id = ?
                ORDER BY at_sec, id
                """,
                (session_id,),
            ).fetchall()
        return [
            ChatMessage(
                id=row["id"],
                session_id=row["session_id"],
                client_id=row["client_id"],
                author=row["author"],
                text=row["text"],
                at_sec=row["at_sec"],
                historical=bool(row["historical"]),
            )
            for row in rows
        ]

    def delete_session(self, session_id: str) -> None:
        """Remove a session and everything stored for it."""
        with self._lock:
            for table in ("segments", "notes", "chat_messages", "sessions"):
                self._conn.execute(f"DELETE FROM {table} WHERE session_id = ?", (session_id,))
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()


def _row_to_session(row: sqlite3.Row) -> Session:
    return Session(
        session_id=row["session_id"],
        chunks=row["chunks"],
        audio_bytes=row["audio_bytes"],
        started_at=row["started_at"],
        stopped_at=row["stopped_at"],
        status=row["status"],
        file=row["file"],
        transcript_segments=row["transcript_segments"],
        language=row["language"],
        duration_sec=row["duration_sec"],
        error=row["error"],
        title=row["title"],
        meeting_code=row["meeting_code"],
    )
