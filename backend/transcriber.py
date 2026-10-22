"""Whisper model reuse and the per-session transcribe adapter.

The model is expensive to load and safe to share, so it is cached per configuration for
the life of the process. Language, by contrast, is a per-call argument — so a single
shared model can serve concurrent sessions transcribing different languages.
"""
from __future__ import annotations

import logging
import threading
from typing import Any, Callable, Dict, List, Optional, Tuple

import numpy as np

logger = logging.getLogger(__name__)

ModelFactory = Callable[..., Any]

_models: Dict[Tuple[str, str, str], Any] = {}
_lock = threading.Lock()


def _load_whisper(model_size: str, device: str, compute_type: str):
    from faster_whisper import WhisperModel  # imported lazily: heavy, and not needed in tests

    logger.info(
        "Loading whisper model %s (device=%s, compute=%s)", model_size, device, compute_type
    )
    model = WhisperModel(model_size, device=device, compute_type=compute_type)
    logger.info("Whisper model %s ready", model_size)
    return model


def get_model(
    model_size: str = "base",
    device: str = "auto",
    compute_type: str = "auto",
    factory: Optional[ModelFactory] = None,
):
    """Return the shared model for this configuration, loading it at most once."""
    key = (model_size, device, compute_type)
    with _lock:
        if key not in _models:
            build = factory or _load_whisper
            _models[key] = build(model_size, device=device, compute_type=compute_type)
        return _models[key]


def is_loaded(model_size: str, device: str = "auto", compute_type: str = "auto") -> bool:
    """Whether this configuration is already in memory, without loading it."""
    with _lock:
        return (model_size, device, compute_type) in _models


def reset_model_cache() -> None:
    """Drop cached models. Used by tests; also lets a long-lived process reclaim RAM."""
    with _lock:
        _models.clear()


class WhisperTranscriber:
    """Turns one bounded window of PCM into raw segments for a single session."""

    def __init__(
        self,
        model: Any,
        language: str | None = None,
        hotwords: str | None = None,
        beam_size: int = 5,
    ):
        self._model = model
        self.language = language
        self.beam_size = beam_size
        # names and terms to expect (see vocabulary.py); may change during the session,
        # as participants join
        self.hotwords = hotwords

    def __call__(self, audio: np.ndarray) -> List[Any]:
        segments, info = self._model.transcribe(
            audio,
            language=self.language,
            hotwords=self.hotwords or None,
            beam_size=self.beam_size,
            vad_filter=True,
            vad_parameters=dict(
                min_silence_duration_ms=500,
                speech_pad_ms=200,
                threshold=0.3,
            ),
            # each window is transcribed independently; carrying context across windows
            # lets a hallucinated phrase repeat itself for the rest of the meeting
            condition_on_previous_text=False,
        )
        # faster-whisper defers all inference into this generator — consume it here
        return list(segments)
