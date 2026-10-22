"""Terms Whisper should expect. Names here are made up."""
from __future__ import annotations

from backend.vocabulary import MAX_CHARS, clean, configured_terms, hotwords


def test_the_inline_list_is_comma_separated(monkeypatch):
    monkeypatch.setenv("GHOSTMEET_VOCABULARY", " ClickHouse, Metabase ,,RPA ")
    monkeypatch.delenv("GHOSTMEET_VOCABULARY_FILE", raising=False)

    assert configured_terms() == ["ClickHouse", "Metabase", "RPA"]


def test_the_file_has_one_term_per_line_and_comments(monkeypatch, tmp_path):
    words = tmp_path / "vocabulary.txt"
    words.write_text("# people\nAna Souza\nBruno Lima  # product\n\nOKR\n", encoding="utf-8")
    monkeypatch.setenv("GHOSTMEET_VOCABULARY", "OKR")
    monkeypatch.setenv("GHOSTMEET_VOCABULARY_FILE", str(words))

    assert configured_terms() == ["OKR", "Ana Souza", "Bruno Lima"]


def test_a_missing_file_is_not_fatal(monkeypatch, tmp_path):
    monkeypatch.delenv("GHOSTMEET_VOCABULARY", raising=False)
    monkeypatch.setenv("GHOSTMEET_VOCABULARY_FILE", str(tmp_path / "nope.txt"))

    assert configured_terms() == []


def test_terms_are_trimmed_and_deduplicated_ignoring_case():
    assert clean(["Ana  Souza", "ana souza", "", None, "x" * 81, "RPA"]) == ["Ana Souza", "RPA"]


def test_your_terms_and_the_participants_make_one_hint():
    assert hotwords(["ClickHouse"], ["Ana Souza", "clickhouse"]) == "ClickHouse, Ana Souza"


def test_nothing_to_hint_is_no_hint():
    assert hotwords([], []) is None


def test_the_hint_is_cut_to_what_whisper_can_take():
    many = [f"Term number {i}" for i in range(200)]

    hint = hotwords(many)

    assert len(hint) <= MAX_CHARS
    assert hint.startswith("Term number 0, Term number 1")
