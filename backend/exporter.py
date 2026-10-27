"""Writes finished transcripts as markdown files, so they can be browsed and handed to
an agent without going through the API or the SQLite database.

    python -m backend.exporter            # (re)export every stored session
"""

from __future__ import annotations

import datetime as dt
import logging
import os
from collections.abc import Sequence
from pathlib import Path

from .cleanup import clean
from .incremental import Segment
from .models import ChatMessage, Note, Session
from .retention import worth_keeping
from .speakers import attribute, load_events

logger = logging.getLogger(__name__)


def export_dir() -> Path | None:
    """Target folder, or None when exporting is switched off (variable unset or empty)."""
    raw = os.environ.get("LOURO_EXPORT_DIR", "")
    return Path(raw).expanduser() if raw.strip() else None


def _stamp(seconds: float) -> str:
    total = int(seconds)
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours:d}:{minutes:02d}:{secs:02d}" if hours else f"{minutes:02d}:{secs:02d}"


def export_path(session: Session, target: Path | None = None) -> Path | None:
    target = target or export_dir()
    if target is None:
        return None
    started = dt.datetime.fromisoformat(session.started_at)
    return target / f"{started:%Y-%m-%d_%H%M}_{session.session_id}.md"


def remove_export(session: Session, target: Path | None = None) -> None:
    """Delete a session's markdown copy, e.g. one written before it was discarded."""
    path = export_path(session, target)
    if path is not None:
        path.unlink(missing_ok=True)


def export_session(
    session: Session,
    segments: Sequence[Segment],
    target: Path | None = None,
    speaker_events: Path | None = None,
    notes: Sequence[Note] = (),
    chat_messages: Sequence[ChatMessage] = (),
) -> Path | None:
    """Write one session as markdown. With `speaker_events` (the Google Meet log), lines
    get the name of whoever was speaking when the meeting UI showed it clearly."""
    target = target or export_dir()
    segments = clean(segments)
    if target is None or (not segments and not chat_messages):
        return None
    target.mkdir(parents=True, exist_ok=True)

    events = load_events(speaker_events) if speaker_events else []
    speakers = attribute(segments, events, session.started_at) if events else [None] * len(segments)

    started = dt.datetime.fromisoformat(session.started_at)
    path = export_path(session, target)
    when = f"{started:%d/%m/%Y %H:%M}"
    lines = [
        f"# {session.title} ({when})" if session.title else f"# Reunião {when}",
        "",
        f"- sessão: {session.session_id}",
        f"- duração: {_stamp(session.duration_sec)}",
        f"- idioma: {session.language or 'auto'}",
        f"- status: {session.status}",
    ]
    if session.meeting_code:
        lines.append(f"- meet: {session.meeting_code}")
    if events:
        lines.append("- falantes: estimados pelo indicador de áudio do Google Meet (aproximado)")
    lines += [
        "",
        "## Transcrição",
        "",
    ]
    timeline: list[tuple[int, float, int, int, str]] = []
    for index, message in enumerate(chat_messages):
        order = message.id if message.id is not None else index
        group = 0 if message.historical else 1
        at_sec = 0.0 if message.historical else message.at_sec
        priority = 0 if message.historical else 1
        timeline.append((group, at_sec, priority, order, _chat_line(message)))
    for index, note in enumerate(notes):
        timeline.append((1, note.at_sec, 0, index, _note_line(note)))
    for index, (segment, speaker) in enumerate(zip(segments, speakers, strict=True)):
        who = f"{speaker}: " if speaker else ""
        text = f"[{_stamp(segment.start)}] {who}{segment.text.strip()}"
        timeline.append((1, segment.start, 2, index, text))
    lines.extend(item[-1] for item in sorted(timeline))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def _note_line(note: Note) -> str:
    if note.text:
        return f"[{_stamp(note.at_sec)}] 📝 Nota: {note.text}"
    return f"[{_stamp(note.at_sec)}] 📌 Momento marcado"


def _chat_line(message: ChatMessage) -> str:
    if message.historical:
        return f"[já visível ao iniciar] 💬 {message.author}: {message.text}"
    return f"[{_stamp(message.at_sec)}] 💬 {message.author}: {message.text}"


def export_all() -> int:
    from .store import SessionStore, default_data_dir

    recordings = default_data_dir()
    store = SessionStore(recordings / "louro.db")
    count = 0
    for session in store.load_sessions().values():
        segments = store.load_segments(session.session_id)
        chat_messages = store.load_chat_messages(session.session_id)
        if not worth_keeping(session, segments, has_chat=bool(chat_messages)):
            continue
        events = recordings / f"{session.session_id}.speakers.jsonl"
        notes = store.load_notes(session.session_id)
        if export_session(
            session,
            segments,
            speaker_events=events,
            notes=notes,
            chat_messages=chat_messages,
        ):
            count += 1
    store.close()
    return count


if __name__ == "__main__":
    print(f"{export_all()} transcrições exportadas para {export_dir()}")
