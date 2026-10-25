"""The on-export hook: your command runs, the meeting's content never does."""

from __future__ import annotations

from backend.hooks import run_on_export
from backend.models import Session


def _run(monkeypatch, tmp_path, command, title):
    monkeypatch.setenv("LOURO_ON_EXPORT", command)
    session = Session(session_id="s1", title=title)
    transcript = tmp_path / "s1.md"
    transcript.write_text("# s1\n", encoding="utf-8")
    process = run_on_export(session, transcript, log_dir=tmp_path)
    assert process is not None
    assert process.wait(timeout=10) == 0


def test_the_meeting_reaches_the_command_through_its_environment(monkeypatch, tmp_path):
    out = tmp_path / "out.txt"

    _run(monkeypatch, tmp_path, f'printf "%s" "$LOURO_TITLE" > {out}', "Weekly sync")

    assert out.read_text() == "Weekly sync"


def test_a_meeting_title_is_never_executed(monkeypatch, tmp_path):
    """Anyone can name a meeting you join: its title must stay text."""
    planted = tmp_path / "planted"
    title = f"$(touch {planted}); `touch {planted}`; touch {planted}"
    out = tmp_path / "out.txt"

    _run(monkeypatch, tmp_path, f'printf "%s" "$LOURO_TITLE" > {out}', title)

    assert out.read_text() == title
    assert not planted.exists()


def test_nothing_runs_without_a_command(monkeypatch, tmp_path):
    monkeypatch.delenv("LOURO_ON_EXPORT", raising=False)

    assert run_on_export(Session(session_id="s1"), tmp_path / "s1.md", log_dir=tmp_path) is None
