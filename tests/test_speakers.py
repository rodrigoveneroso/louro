"""Speaker attribution from the Google Meet UI log. All names here are made up."""

from __future__ import annotations

import datetime as dt
import json

from backend.exporter import export_session
from backend.incremental import Segment
from backend.models import Session
from backend.speakers import attribute, load_events

STARTED = "2026-01-05T10:00:00"
ORIGIN_MS = dt.datetime.fromisoformat(STARTED).timestamp() * 1000

TILES = {"tile-a": "Ana Souza", "tile-b": "Bruno Lima"}


def meter(tile: str, at_sec: float, count: int, el: str = "MeterX") -> list[dict]:
    """`count` level changes on a tile's meter, a tenth of a second apart."""
    return [
        {
            "t": ORIGIN_MS + (at_sec + i / 10) * 1000,
            "tile": tile,
            "name": TILES[tile],
            "el": el,
            "from": "l1",
            "to": "l2",
        }
        for i in range(count)
    ]


def label(tile: str, name: str) -> dict:
    """A control inside the tile (mute button, tooltip) whose text is not a name."""
    return {"t": ORIGIN_MS, "tile": tile, "name": name, "el": "div", "from": "", "to": "x"}


def test_each_segment_goes_to_whoever_was_speaking():
    events = meter("tile-a", 1.0, 10) + meter("tile-b", 5.0, 10)
    segments = [Segment("olá", 1.0, 2.0), Segment("oi", 5.0, 6.0)]

    assert attribute(segments, events, STARTED) == ["Ana Souza", "Bruno Lima"]


def test_overlapping_speech_is_left_unattributed():
    events = meter("tile-a", 1.0, 10) + meter("tile-b", 1.0, 9)

    assert attribute([Segment("x", 1.0, 2.0)], events, STARTED) == [None]


def test_a_few_stray_meter_changes_are_not_speech():
    events = meter("tile-a", 1.0, 2)

    assert attribute([Segment("x", 1.0, 2.0)], events, STARTED) == [None]


def test_control_labels_are_never_taken_for_names():
    events = meter("tile-a", 1.0, 10) + [label("tile-a", "Desativar som")] * 50
    events += [label("tile-a", "Mute")] * 50

    assert attribute([Segment("x", 1.0, 2.0)], events, STARTED) == ["Ana Souza"]


def test_layout_elements_are_not_mistaken_for_the_meter():
    events = meter("tile-a", 1.0, 10) + meter("tile-b", 1.0, 40, el="div")

    assert attribute([Segment("x", 1.0, 2.0)], events, STARTED) == ["Ana Souza"]


def test_without_events_nobody_is_named():
    assert attribute([Segment("x", 0.0, 1.0)], [], STARTED) == [None]


def test_a_torn_last_line_is_skipped(tmp_path):
    path = tmp_path / "s.speakers.jsonl"
    path.write_text(json.dumps(meter("tile-a", 0, 1)[0]) + "\n" + '{"t": 1, "ti', encoding="utf-8")

    assert len(load_events(path)) == 1


def test_export_names_the_speaker_of_each_line(tmp_path):
    log = tmp_path / "s.speakers.jsonl"
    log.write_text("\n".join(json.dumps(e) for e in meter("tile-a", 1.0, 10)), encoding="utf-8")
    session = Session(session_id="s", started_at=STARTED, duration_sec=10)
    segments = [Segment("olá", 1.0, 2.0), Segment("silêncio", 8.0, 9.0)]

    path = export_session(session, segments, target=tmp_path / "out", speaker_events=log)
    text = path.read_text()

    assert "[00:01] Ana Souza: olá" in text
    assert "[00:08] silêncio" in text
    assert "falantes:" in text


def test_export_without_a_log_keeps_plain_lines(tmp_path):
    session = Session(session_id="s", started_at=STARTED, duration_sec=10)

    text = export_session(session, [Segment("olá", 1.0, 2.0)], target=tmp_path).read_text()

    assert "[00:01] olá" in text
    assert "falantes:" not in text


def test_export_puts_the_meeting_name_in_the_title(tmp_path):
    session = Session(
        session_id="s",
        started_at=STARTED,
        duration_sec=10,
        title="Weekly sync",
        meeting_code="abc-defg-hij",
    )

    text = export_session(session, [Segment("olá", 1.0, 2.0)], target=tmp_path).read_text()

    assert text.startswith("# Weekly sync (05/01/2026 10:00)")
    assert "- meet: abc-defg-hij" in text
