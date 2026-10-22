"""Writes finished transcripts as markdown files, so they can be browsed and handed to
an agent without going through the API or the SQLite database.

    python -m backend.exporter            # (re)export every stored session
"""
from __future__ import annotations

import datetime as dt
import logging
import os
from pathlib import Path
from typing import Sequence

from .incremental import Segment
from .models import Session

logger = logging.getLogger(__name__)


def export_dir() -> Path | None:
    """Target folder, or None when exporting is switched off (variable unset or empty)."""
    raw = os.environ.get("GHOSTMEET_EXPORT_DIR", "")
    return Path(raw).expanduser() if raw.strip() else None


def _stamp(seconds: float) -> str:
    total = int(seconds)
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours:d}:{minutes:02d}:{secs:02d}" if hours else f"{minutes:02d}:{secs:02d}"


def export_session(session: Session, segments: Sequence[Segment], target: Path | None = None) -> Path | None:
    target = target or export_dir()
    if target is None or not segments:
        return None
    target.mkdir(parents=True, exist_ok=True)

    started = dt.datetime.fromisoformat(session.started_at)
    path = target / f"{started:%Y-%m-%d_%H%M}_{session.session_id}.md"
    lines = [
        f"# Reunião {started:%d/%m/%Y %H:%M}",
        "",
        f"- sessão: {session.session_id}",
        f"- duração: {_stamp(session.duration_sec)}",
        f"- idioma: {session.language or 'auto'}",
        f"- status: {session.status}",
        "",
        "## Transcrição",
        "",
    ]
    lines += [f"[{_stamp(s.start)}] {s.text.strip()}" for s in segments]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def export_all() -> int:
    from .store import SessionStore

    store = SessionStore(Path(__file__).resolve().parent.parent / "recordings" / "ghostmeet.db")
    count = 0
    for session in store.load_sessions().values():
        if export_session(session, store.load_segments(session.session_id)):
            count += 1
    store.close()
    return count


if __name__ == "__main__":
    print(f"{export_all()} transcrições exportadas para {export_dir()}")
