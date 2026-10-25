"""Tidying the exported transcript. Every line here is made up."""

from __future__ import annotations

from backend.cleanup import clean
from backend.incremental import Segment


def texts(*segments):
    return [s.text for s in clean(list(segments))]


def test_words_repeated_across_a_window_edge_are_dropped_once():
    assert texts(
        Segment("Então, Ana, vamos revisar o painel de vendas.", 0, 9.4),
        Segment("painel de vendas antes de sexta-feira", 8, 14),  # re-read 1.4 s
    ) == [
        "Então, Ana, vamos revisar o painel de vendas.",
        "antes de sexta-feira",
    ]


def test_a_segment_that_only_repeats_the_previous_one_disappears():
    assert texts(
        Segment("Depois a gente fecha o relatório do mês...", 0, 3),
        Segment("fecha o relatório do mês", 1.5, 3.2),
    ) == ["Depois a gente fecha o relatório do mês..."]


def test_a_single_repeated_word_is_left_alone():
    """Too little to tell a window edge from someone repeating themselves."""
    assert texts(Segment("Vamos começar", 0, 2), Segment("começar pela pauta", 1, 3)) == [
        "Vamos começar",
        "começar pela pauta",
    ]


def test_a_reply_that_echoes_the_previous_words_is_kept():
    """A question, then its answer, back to back: no time overlap, so no edge."""
    question = Segment("Pode ser amanhã?", 38, 40.3)
    answer = Segment("Pode ser amanhã, sim.", 40, 42)
    assert texts(question, answer) == [
        "Pode ser amanhã?",
        "Pode ser amanhã, sim.",
    ]


def test_accents_and_punctuation_do_not_hide_a_repetition():
    assert texts(
        Segment("A decisão é subir em produção.", 0, 3),
        Segment("em producao, na segunda semana", 2, 6),
    ) == ["A decisão é subir em produção.", "na segunda semana"]


def test_subtitle_credits_made_up_in_silence_are_dropped():
    assert texts(
        Segment("Obrigada a todos, até a próxima.", 0, 2),
        Segment("Legendas pela comunidade de Amara.org", 2, 4),
        Segment("Obrigado por assistir!", 10, 11),
    ) == ["Obrigada a todos, até a próxima."]


def test_a_long_sentence_mentioning_a_credit_is_kept():
    line = "Eu vi naquele vídeo que pedia inscreva-se no canal, mas o ponto era outro."
    assert texts(Segment(line, 0, 6)) == [line]


def test_times_and_speakers_survive():
    out = clean([Segment("um dois três", 0, 2), Segment("dois três quatro", 1, 3, speaker="Ana")])
    assert (out[1].text, out[1].start, out[1].speaker) == ("quatro", 1, "Ana")
