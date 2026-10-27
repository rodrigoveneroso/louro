"""Which finished sessions are worth keeping.

Opening the side panel by accident, a capture started on the wrong tab or a call left
after a few seconds all leave a session behind. Those are dropped rather than piling up
next to real meetings: a session is kept only if speech or chat was captured and it
lasted at least LOURO_MIN_DURATION_SEC (default 30 s). 0 turns this off and keeps every
capture, silent ones included.
"""

from __future__ import annotations

import os
from collections.abc import Sequence

from .incremental import Segment
from .models import Session

DEFAULT_MIN_DURATION_SEC = 30.0


def min_duration_sec() -> float:
    raw = os.environ.get("LOURO_MIN_DURATION_SEC", "").strip()
    try:
        return max(0.0, float(raw)) if raw else DEFAULT_MIN_DURATION_SEC
    except ValueError:
        return DEFAULT_MIN_DURATION_SEC


def should_discard(
    session: Session,
    segments: Sequence[Segment],
    stopped_by_client: bool,
    has_chat: bool = False,
) -> bool:
    """Only a capture the user stopped is judged. One whose connection dropped is
    probably about to be resumed, and a short first stretch must not take the session
    (and its start time) with it."""
    return stopped_by_client and not worth_keeping(session, segments, has_chat)


def worth_keeping(session: Session, segments: Sequence[Segment], has_chat: bool = False) -> bool:
    minimum = min_duration_sec()
    if minimum == 0:
        return True
    return (bool(segments) or has_chat) and session.duration_sec >= minimum
