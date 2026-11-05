"""Turns: what one person said in a row, written as one line of the exported transcript.

Whisper cuts speech into short lines (a sentence or two), which is the right unit to
time, attribute and correct, so that is how the transcript is stored and shown live. Read
afterwards, the same name at the start of six lines in a row is noise, and the turns are
what a reader (or an agent summarising the meeting) looks for. So the export joins the
lines one person said one after another, and starts a new line when someone else speaks,
after a long pause, at the first sentence end after about a minute (a monologue in one
line is a wall of text; two minutes at most, for speech with no punctuation), or where a
note or a chat message falls, so those stay where they happened.

Lines nobody could be named for are left as they are: they may be different people.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import replace

from .incremental import Segment

TURN_SOFT_SEC = 60.0  # from here on, a line ends where a sentence does
TURN_MAX_SEC = 120.0
_SENTENCE_END = (".", "?", "!", "…")
TURN_MAX_GAP_SEC = 4.0  # a longer silence starts a new line, even from the same person


def turns(segments: Sequence[Segment], breaks: Iterable[float] = ()) -> list[Segment]:
    """`segments` with each run from one named speaker joined, never across `breaks`
    (session times of notes and chat messages)."""
    breaks = sorted(breaks)
    joined: list[Segment] = []
    for segment in segments:
        last = joined[-1] if joined else None
        if (
            last is not None
            and segment.speaker
            and segment.speaker == last.speaker
            and segment.start - last.end <= TURN_MAX_GAP_SEC
            and _room_for(last, segment)
            and not any(last.start < at <= segment.start for at in breaks)
        ):
            joined[-1] = replace(
                last,
                text=f"{last.text.strip()} {segment.text.strip()}",
                end=max(last.end, segment.end),
                edited=last.edited or segment.edited,
            )
        else:
            joined.append(segment)
    return joined


def _room_for(turn: Segment, segment: Segment) -> bool:
    length = segment.end - turn.start
    if length <= TURN_SOFT_SEC:
        return True
    return length <= TURN_MAX_SEC and not turn.text.rstrip().endswith(_SENTENCE_END)
