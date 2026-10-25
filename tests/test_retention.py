from __future__ import annotations

import pytest

from backend.incremental import Segment
from backend.models import Session
from backend.retention import min_duration_sec, should_discard, worth_keeping

SPEECH = [Segment(text="olá", start=0.0, end=1.0)]


@pytest.fixture(autouse=True)
def default_minimum(monkeypatch):
    # the shared test setup lowers the minimum to 0 for stub recordings
    monkeypatch.delenv("LOURO_MIN_DURATION_SEC", raising=False)


def session(seconds: float) -> Session:
    return Session(session_id="s", duration_sec=seconds)


def test_a_real_meeting_is_kept():
    assert worth_keeping(session(600), SPEECH)


def test_a_capture_shorter_than_the_minimum_is_dropped():
    assert not worth_keeping(session(12), SPEECH)


def test_a_long_capture_where_nobody_spoke_is_dropped():
    assert not worth_keeping(session(3600), [])


@pytest.mark.parametrize(
    ("raw", "expected"), [("", 30.0), ("90", 90.0), ("0", 0.0), ("-5", 0.0), ("soon", 30.0)]
)
def test_the_minimum_comes_from_the_environment(monkeypatch, raw, expected):
    monkeypatch.setenv("LOURO_MIN_DURATION_SEC", raw)
    assert min_duration_sec() == expected


def test_a_zero_minimum_turns_the_filter_off(monkeypatch):
    monkeypatch.setenv("LOURO_MIN_DURATION_SEC", "0")
    assert worth_keeping(session(2), SPEECH)
    assert worth_keeping(session(2), [])


def test_a_short_capture_the_user_stopped_is_discarded():
    assert should_discard(session(12), SPEECH, stopped_by_client=True)


def test_a_short_capture_whose_connection_dropped_is_kept_for_its_resume():
    assert not should_discard(session(12), SPEECH, stopped_by_client=False)


def test_a_real_meeting_is_never_discarded():
    assert not should_discard(session(600), SPEECH, stopped_by_client=True)
