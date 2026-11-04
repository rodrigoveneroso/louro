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


def test_a_segment_you_edited_is_exported_as_you_wrote_it():
    previous = Segment("Vamos começar pela pauta", 0, 2)
    edited = Segment("pela pauta de hoje, e depois o resto", 1, 3, edited=True)
    credit = Segment("Inscreva-se no canal", 3, 4, edited=True)

    assert texts(previous, edited, credit) == [
        "Vamos começar pela pauta",
        "pela pauta de hoje, e depois o resto",
        "Inscreva-se no canal",
    ]


def test_a_short_line_stuck_on_repeat_is_kept_once():
    loop = [Segment("Pode ser.", 10 + i, 11 + i) for i in range(6)]
    after = Segment("Então seguimos com o plano.", 17, 19)

    assert texts(*loop, after) == ["Pode ser.", "Então seguimos com o plano."]


def test_the_same_short_line_with_pauses_between_is_real():
    cheers = [Segment("Boa!", 0, 0.8), Segment("Boa!", 4, 4.6), Segment("Boa!", 12, 12.5)]

    assert texts(*cheers) == ["Boa!", "Boa!", "Boa!"]


def test_a_short_line_said_twice_stays_twice():
    assert texts(Segment("Sim.", 0, 1), Segment("Sim.", 1, 2), Segment("Ok.", 2, 3)) == [
        "Sim.",
        "Sim.",
        "Ok.",
    ]


def test_a_long_line_repeated_is_not_a_loop():
    line = "a gente precisa revisar o contrato antes da reunião"
    repeated = [Segment(line, i * 10, i * 10 + 4) for i in range(3)]

    assert texts(*repeated) == [line] * 3


def test_a_word_said_over_and_over_in_a_line_is_cut_to_three():
    assert texts(Segment("Ana, Ana, Ana, Ana, Ana, Ana, Ana", 0, 3)) == ["Ana, Ana, Ana"]
    assert texts(Segment("Então foi foi foi foi foi foi, beleza.", 0, 3)) == ["Então foi foi foi, beleza."]
    assert texts(Segment("vai lá, vai lá, vai lá, vai lá, vai lá", 0, 4)) == [
        "vai lá, vai lá, vai lá"
    ]


def test_a_word_said_a_few_times_in_a_line_stays():
    assert texts(Segment("Sim, sim, sim, sim.", 0, 2)) == ["Sim, sim, sim, sim."]
    assert texts(Segment("Não, não, não, não, não é isso.", 2, 5)) == ["Não, não, não é isso."]
