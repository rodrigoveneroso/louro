"""Words Whisper should expect: names, acronyms and jargon it would otherwise mishear.

Two sources, combined per session:

- your own list, from LOURO_VOCABULARY (comma separated) and/or
  LOURO_VOCABULARY_FILE (one term per line, `#` starts a comment). The file is read
  at the start of every session, so editing it needs no restart;
- the names of the meeting's participants, as the meeting page shows them.

They reach faster-whisper as `hotwords`, a hint rather than a constraint: a term that
is not said is not forced into the transcript.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Iterable, List

logger = logging.getLogger(__name__)

# hotwords share Whisper's 224-token prompt; past this a longer list only gets cut
MAX_CHARS = 600
MAX_TERM = 80


def configured_terms() -> List[str]:
    terms = _split(os.environ.get("LOURO_VOCABULARY", ""), ",")
    path = os.environ.get("LOURO_VOCABULARY_FILE", "").strip()
    if path:
        try:
            lines = Path(path).expanduser().read_text(encoding="utf-8").splitlines()
        except OSError as error:
            logger.warning("Cannot read the vocabulary file %s: %s", path, error)
        else:
            terms += [line.split("#", 1)[0] for line in lines]
    return clean(terms)


def clean(terms: Iterable[object]) -> List[str]:
    """Trimmed, de-duplicated (case-insensitively), short strings, in their order."""
    seen, kept = set(), []
    for term in terms:
        if not isinstance(term, str):
            continue
        term = " ".join(term.split())
        if not term or len(term) > MAX_TERM or term.lower() in seen:
            continue
        seen.add(term.lower())
        kept.append(term)
    return kept


def hotwords(*sources: Iterable[str]) -> str | None:
    """One hint string from several term lists, cut to what Whisper can take."""
    text = ""
    for term in clean(term for source in sources for term in source):
        candidate = f"{text}, {term}" if text else term
        if len(candidate) > MAX_CHARS:
            break
        text = candidate
    return text or None


def _split(raw: str, separator: str) -> List[str]:
    return [part for chunk in raw.splitlines() for part in chunk.split(separator)]
