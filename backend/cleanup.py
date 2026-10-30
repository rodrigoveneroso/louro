"""Tidying a transcript before it is exported: what Whisper gets wrong in predictable ways.

- Window edges. The live transcript is made of overlapping windows, and words straddling
  an edge can come out at the end of one segment and again at the start of the next
  ("...vamos revisar o painel de vendas." / "painel de vendas antes de sexta..."). Such
  a repetition always comes from audio read twice, so the two segments overlap in time
  (by 1-2 s in real meetings); a reply that echoes the previous words ("pode ser amanhã?"
  / "Pode ser amanhã, sim.") follows it instead, and is left alone. The repeated words
  are taken off the second segment.
- Subtitle credits (see credits.py). New transcripts never store them, but meetings
  transcribed before that filter still have them, so a re-export drops them too.

The stored transcript is left as it was: this only shapes the exported copy, so better
rules can be applied again to old meetings by re-exporting them.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence
from dataclasses import replace

from .credits import is_credit
from .incremental import Segment

MIN_OVERLAP_WORDS = 2
MAX_OVERLAP_WORDS = 12
# how much two segments must overlap in time for a repetition to be a re-read edge
MIN_OVERLAP_SEC = 0.5


def clean(segments: Sequence[Segment]) -> list[Segment]:
    """The segments to export, in order: credits dropped, edge repetitions trimmed."""
    kept: list[Segment] = []
    for segment in segments:
        if is_credit(segment.text, segment.end - segment.start):
            continue
        if kept:
            segment = _trim_repeat(kept[-1], segment)
            if not segment.text:
                continue
        kept.append(segment)
    return kept


def _words(text: str) -> list[str]:
    folded = unicodedata.normalize("NFKD", text.lower())
    folded = "".join(ch for ch in folded if not unicodedata.combining(ch))
    return re.findall(r"\w+", folded)


def _trim_repeat(previous: Segment, segment: Segment) -> Segment:
    """Drop the words at the start of `segment` that repeat the end of `previous`."""
    if segment.start > previous.end - MIN_OVERLAP_SEC:
        return segment  # one after the other: someone said it again
    before, after = _words(previous.text), _words(segment.text)
    longest = 0
    for size in range(min(MAX_OVERLAP_WORDS, len(before), len(after)), MIN_OVERLAP_WORDS - 1, -1):
        if before[-size:] == after[:size]:
            longest = size
            break
    if not longest:
        return segment
    return replace(segment, text=_drop_words(segment.text, longest))


def _drop_words(text: str, count: int) -> str:
    """`text` without its first `count` words, keeping the rest exactly as written."""
    matches = list(re.finditer(r"\w+", text))
    if count >= len(matches):
        return ""
    rest = text[matches[count - 1].end() :]
    return rest.lstrip(" ,.;:!?…-").strip()
