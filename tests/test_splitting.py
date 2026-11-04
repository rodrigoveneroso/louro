"""Long Whisper segments cut into lines. Every line here is made up."""

from __future__ import annotations

from types import SimpleNamespace

from backend.splitting import split_long


def word(start, end, text):
    return SimpleNamespace(start=start, end=end, word=text)


def segment(*words, start=None, end=None):
    start = words[0].start if start is None else start
    end = words[-1].end if end is None else end
    text = "".join(w.word for w in words)
    return SimpleNamespace(start=start, end=end, text=text, words=list(words))


def lines(segment):
    return [(line.start, line.end, line.text) for line in split_long(segment)]


def test_a_short_segment_stays_one_line():
    short = segment(word(0, 1, " Bom"), word(1, 2, " dia."), word(2.5, 4, " Vamos lá."))
    assert split_long(short) == [short]


def test_a_long_segment_is_cut_where_sentences_end_and_people_pause():
    long = segment(
        word(0.0, 1.0, " A entrega"),
        word(1.0, 2.5, " ficou pronta."),  # a sentence ends
        word(2.6, 4.0, " Quem"),
        word(4.0, 5.5, " testa"),
        word(5.5, 6.0, " hoje?"),  # and another
        word(6.1, 7.0, " Eu"),
        word(7.0, 8.2, " posso,"),
        word(9.0, 10.0, " depois"),  # after a pause
        word(10.0, 12.0, " do almoço"),
    )

    assert lines(long) == [
        (0.0, 2.5, "A entrega ficou pronta."),
        (2.6, 6.0, "Quem testa hoje?"),
        (6.1, 8.2, "Eu posso,"),
        (9.0, 12.0, "depois do almoço"),
    ]


def test_no_line_is_too_short_to_name_a_speaker():
    long = segment(
        word(0.0, 0.5, " Sim."),  # too short alone: stays with what follows
        word(0.6, 6.0, " pode mandar a versão nova"),
        word(6.5, 10.5, " que eu olho amanhã."),  # after a pause
        word(10.6, 11.2, " Ok."),  # too short alone: stays with what precedes
    )

    assert lines(long) == [
        (0.0, 6.0, "Sim. pode mandar a versão nova"),
        (6.5, 11.2, "que eu olho amanhã. Ok."),
    ]


def test_speech_without_pauses_is_still_cut_into_lines():
    words = [word(i * 0.5, i * 0.5 + 0.5, " palavra") for i in range(50)]  # 25 s, no pause

    cut = lines(segment(*words))

    assert len(cut) == 3
    assert all(end - start <= 10.5 for start, end, _ in cut)
    assert " ".join(text for *_, text in cut) == " ".join(["palavra"] * 50)


def test_a_segment_without_word_times_stays_whole():
    long = SimpleNamespace(start=0.0, end=25.0, text=" sem tempos por palavra", words=None)
    assert split_long(long) == [long]
