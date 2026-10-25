"""Who was speaking, worked out from Google Meet's per-participant audio indicator.

The content script (`extension/meet-speakers.js`) logs every class change inside a
participant tile, without knowing what any of them mean: Meet's class names are
obfuscated and change between releases. Here the audio level meter is recognised as the
element that changes most often, and each transcript segment goes to the participant
whose meter moved the most while it was being said. When nobody clearly dominates the
segment is left without a speaker rather than guessed.
"""

from __future__ import annotations

import bisect
import datetime as dt
import json
import re
from collections import Counter, defaultdict
from collections.abc import Sequence
from pathlib import Path

from .incremental import Segment

# elements without a jsname are logged by tag; those are layout, not the meter
_TAGS = {"div", "span", "i", "svg", "path", "img", "button", "p", "a", "g", "circle", "video"}
# leaf texts of a tile that are controls or tooltips, not a person's name (pt + en UI)
_NOT_A_NAME = re.compile(
    r"^(spaces/|devices/)|desativar|ativar|som\b|aumentar|zoom|anota|microfone|mais op|fixar|"
    r"remover|silenciar|reenquadrar|planos de fundo|apresent|\bmute|unmute|\bpin\b|more options|"
    r"remove|notes|reframe|background|present|tela cheia|full ?screen",
    re.IGNORECASE,
)

PAD_SEC = 0.3  # the meter reacts a little after the voice, and segment edges are loose
MIN_EVENTS = 3  # fewer meter changes than this is noise, not speech
DOMINANCE = 1.5  # the top participant needs this many times the runner-up's activity


def load_events(path: Path) -> list[dict]:
    if not path.exists():
        return []
    events = []
    with path.open(encoding="utf-8") as lines:
        for line in lines:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue  # a line cut short by a crash
            if isinstance(event, dict) and {"t", "tile", "el"} <= event.keys():
                events.append(event)
    return events


def _tile_names(events: Sequence[dict]) -> dict[str, str]:
    seen: dict[str, Counter] = defaultdict(Counter)
    for event in events:
        name = str(event.get("name") or "").strip()
        if name and not _NOT_A_NAME.search(name):
            seen[event["tile"]][name] += 1
    return {tile: names.most_common(1)[0][0] for tile, names in seen.items()}


def _meter_element(events: Sequence[dict]) -> str | None:
    counts = Counter(e["el"] for e in events if e["el"] not in _TAGS)
    return counts.most_common(1)[0][0] if counts else None


def attribute(
    segments: Sequence[Segment], events: Sequence[dict], started_at: str
) -> list[str | None]:
    """One speaker name (or None) per segment, in order."""
    names = _tile_names(events)
    meter = _meter_element(events)
    if not names or meter is None:
        return [None] * len(segments)

    origin = dt.datetime.fromisoformat(started_at).timestamp()
    activity = sorted(
        (
            (e["t"] / 1000.0 - origin, names[e["tile"]])
            for e in events
            if e["el"] == meter and e["tile"] in names
        ),
        key=lambda item: item[0],
    )
    times = [t for t, _ in activity]

    speakers: list[str | None] = []
    for segment in segments:
        lo = bisect.bisect_left(times, segment.start - PAD_SEC)
        hi = bisect.bisect_right(times, segment.end + PAD_SEC)
        ranked = Counter(name for _, name in activity[lo:hi]).most_common(2)
        contested = len(ranked) > 1 and ranked[0][1] < DOMINANCE * ranked[1][1]
        if not ranked or ranked[0][1] < MIN_EVENTS or contested:
            speakers.append(None)
        else:
            speakers.append(ranked[0][0])
    return speakers
