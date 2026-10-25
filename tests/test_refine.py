from __future__ import annotations

import pytest

from backend.refine import final_beam_size


@pytest.mark.parametrize(("raw", "beam"), [("", 1), ("5", 5), ("0", 1), ("wide", 1)])
def test_the_second_pass_decodes_greedily_unless_told_otherwise(monkeypatch, raw, beam):
    monkeypatch.setenv("LOURO_FINAL_BEAM", raw)
    assert final_beam_size() == beam
