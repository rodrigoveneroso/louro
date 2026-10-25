"""An optional second, better transcription of a meeting, once it is over.

Live captions use a model small enough to keep up with the meeting. When
LOURO_FINAL_MODEL names a larger one (e.g. `medium`, `large-v3`), the whole
recording is transcribed again with it after Stop, and its transcript replaces the
live one; the audio is deleted only afterwards. A larger model on CPU takes a good
fraction of the meeting's length to run, which is why this is off by default.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import List

from .incremental import IncrementalTranscriber, Segment, TranscribeFn
from .pcm_store import PcmStore


def final_model() -> str | None:
    return os.environ.get("LOURO_FINAL_MODEL", "").strip() or None


def final_beam_size() -> int:
    """Greedy decoding by default. Measured on Portuguese speech, large-v3-turbo with a
    beam of 5 skipped whole sentences of a window, while with 1 it kept them all and
    made 40% fewer errors than the live `small` (tools/bench_whisper.py)."""
    raw = os.environ.get("LOURO_FINAL_BEAM", "").strip()
    return int(raw) if raw.isdigit() and int(raw) > 0 else 1


def transcribe_recording(pcm_path: Path, transcribe: TranscribeFn) -> List[Segment]:
    """The whole recording, window after window, as one finished transcript."""
    pcm = PcmStore(pcm_path)
    try:
        transcriber = IncrementalTranscriber(pcm, transcribe)
        while transcriber.pending_samples > 0:
            before = transcriber.pending_samples
            transcriber.step(force=True)  # nothing more is coming: commit everything
            if transcriber.pending_samples >= before:
                break  # no progress; never loop forever on a bad window
        return transcriber.transcript
    finally:
        pcm.close()
