"""Run a command of yours once a meeting's transcript is written.

LOURO_ON_EXPORT is a shell command, started in the background after each
meeting's markdown export (so it needs LOURO_EXPORT_DIR). It learns about the
meeting from its environment, never from its command line, so nothing a meeting
contains can end up being executed:

    LOURO_TRANSCRIPT    path of the markdown file
    LOURO_SESSION_ID    session id
    LOURO_TITLE         meeting name, or empty
    LOURO_DURATION_SEC  length in seconds

For example, have your AI agent write the summary:

    LOURO_ON_EXPORT='claude -p "Summarise $LOURO_TRANSCRIPT" \\
        > "${LOURO_TRANSCRIPT%.md}.summary.md"'

Its output goes to on-export.log in the data folder.
"""

from __future__ import annotations

import logging
import os
import subprocess
import threading
from pathlib import Path

from .models import Session

logger = logging.getLogger(__name__)


def on_export_command() -> str | None:
    return os.environ.get("LOURO_ON_EXPORT", "").strip() or None


def run_on_export(
    session: Session, transcript: Path | None, log_dir: Path
) -> subprocess.Popen | None:
    command = on_export_command()
    if not command or transcript is None:
        return None
    env = {
        **os.environ,
        "LOURO_TRANSCRIPT": str(transcript),
        "LOURO_SESSION_ID": session.session_id,
        "LOURO_TITLE": session.title or "",
        "LOURO_DURATION_SEC": str(round(session.duration_sec)),
    }
    log_dir.mkdir(parents=True, exist_ok=True)
    with (log_dir / "on-export.log").open("ab") as log:
        log.write(f"--- {session.session_id}: {command}\n".encode())
        log.flush()
        try:
            # the user's own command, from their own configuration: a shell is expected
            process = subprocess.Popen(
                command,
                shell=True,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=True,  # outlives a backend restart, never blocks it
            )
        except OSError:
            logger.exception("Could not run LOURO_ON_EXPORT for %s", session.session_id)
            return None
    # reaped in the background, so a finished command never lingers as a zombie
    threading.Thread(target=process.wait, name="on-export", daemon=True).start()
    return process
