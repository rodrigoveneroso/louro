"""Long Whisper segments cut into lines, so that each line can have its own speaker.

Whisper hands back up to 30 seconds of speech as a single segment when nobody pauses
long enough for it, which in a lively meeting means two or three people in one line,
all of it named after whoever spoke most. With the time of every word, such a segment
is cut where a sentence ends or the speaker pauses, and the speaker of each piece is
then worked out on its own.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

SPLIT_OVER_SEC = 10.0  # segments longer than this are cut into lines
MIN_LINE_SEC = 2.0  # no line shorter than this: a lone word is too short to name a speaker
MAX_LINE_SEC = 10.0  # past this a line is cut at the next word, pause or not
PAUSE_SEC = 0.35  # a gap between two words this long is a place to cut
SENTENCE_END = (".", "?", "!", "…")


@dataclass
class Line:
    start: float
    end: float
    text: str


def split_long(segment: Any) -> list[Any]:
    """`segment` as it is, or as lines when it is long and has the time of its words."""
    words: Sequence[Any] = getattr(segment, "words", None) or []
    if segment.end - segment.start <= SPLIT_OVER_SEC or len(words) < 2:
        return [segment]

    lines: list[list[Any]] = [[]]
    for word, following in zip(words, [*words[1:], None], strict=True):
        current = lines[-1]
        current.append(word)
        if following is None:
            break
        length = word.end - current[0].start
        rest = words[-1].end - following.start
        boundary = (
            word.word.rstrip().endswith(SENTENCE_END)
            or following.start - word.end >= PAUSE_SEC
            or length >= MAX_LINE_SEC
        )
        if boundary and length >= MIN_LINE_SEC and rest >= MIN_LINE_SEC:
            lines.append([])
    return [
        Line(start=line[0].start, end=line[-1].end, text="".join(w.word for w in line).strip())
        for line in lines
    ]
