"""Joining what one person said in a row into one line. Every line is made up."""

from __future__ import annotations

from backend.incremental import Segment
from backend.turns import turns


def said(*segments: Segment) -> list[tuple[str | None, str]]:
    return [(s.speaker, s.text) for s in turns(segments)]


def test_lines_one_person_said_in_a_row_are_one_turn():
    joined = turns(
        [
            Segment("Subi a versão nova.", 0, 3, speaker="Ana Souza"),
            Segment("Podem testar hoje?", 3.2, 5, speaker="Ana Souza"),
            Segment("Testo depois do almoço.", 5.5, 7, speaker="Bruno Lima"),
        ]
    )

    assert [(s.speaker, s.text, s.start, s.end) for s in joined] == [
        ("Ana Souza", "Subi a versão nova. Podem testar hoje?", 0, 5),
        ("Bruno Lima", "Testo depois do almoço.", 5.5, 7),
    ]


def test_lines_nobody_was_named_for_stay_apart():
    assert said(Segment("Sim.", 0, 1), Segment("Pode ser.", 1, 2)) == [
        (None, "Sim."),
        (None, "Pode ser."),
    ]


def test_a_long_pause_starts_a_new_line():
    assert (
        len(
            turns(
                [Segment("Então.", 0, 1, speaker="Ana"), Segment("Voltei.", 9, 10, speaker="Ana")]
            )
        )
        == 2
    )


def test_a_monologue_is_cut_about_every_minute_where_a_sentence_ends():
    talk = [Segment(f"Frase {i}.", i * 10, i * 10 + 9, speaker="Ana") for i in range(13)]

    assert [s.start for s in turns(talk)] == [0, 60, 120]

    talk[5] = Segment("e a frase segue", 50, 59, speaker="Ana")
    assert [s.start for s in turns(talk)] == [0, 70]


def test_speech_without_punctuation_is_still_cut_after_two_minutes():
    talk = [Segment(f"parte {i}", i * 10, i * 10 + 9, speaker="Ana") for i in range(15)]

    assert [s.start for s in turns(talk)] == [0, 120]


def test_a_note_or_chat_message_in_between_splits_the_turn():
    talk = [
        Segment("Primeiro ponto.", 0, 3, speaker="Ana"),
        Segment("Segundo ponto.", 3.5, 6, speaker="Ana"),
    ]

    assert len(turns(talk, breaks=[3.2])) == 2
    assert len(turns(talk, breaks=[10])) == 1


def test_a_turn_with_a_line_you_corrected_counts_as_corrected():
    joined = turns(
        [
            Segment("Oi.", 0, 1, speaker="Ana"),
            Segment("Tudo bem?", 1, 2, speaker="Ana", edited=True),
        ]
    )

    assert joined[0].edited
