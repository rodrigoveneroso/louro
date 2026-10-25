"""Per-session wiring: receive → decode → transcribe → broadcast.

The WebSocket handler only calls `feed()`, which hands bytes to the decoder thread and
returns. Transcription runs on its own schedule in a worker thread, so a slow pass slows
captions down but never stops audio from being received.

That schedule depends on whether anyone is watching the live captions. With nobody
watching, audio only piles up on disk (cheap) and is transcribed in one batch every
`idle_interval_sec`, so the machine stays quiet during the meeting; a viewer arriving
calls `nudge()`, and the backlog is caught up at once and kept live from then on.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from concurrent.futures import ThreadPoolExecutor
from typing import Protocol

from .incremental import IncrementalTranscriber, Segment

logger = logging.getLogger(__name__)

# Bound on how many catch-up passes `stop()` will run before giving up, so a stuck
# session can never spin forever at hangup.
_MAX_DRAIN_PASSES = 2000
# Bound on the passes of one catch-up, for the same reason.
_MAX_CATCH_UP_PASSES = 500


class Decoder(Protocol):
    def feed(self, chunk: bytes) -> None: ...
    def close(self, timeout: float = ...) -> None: ...


OnSegments = Callable[[list[Segment]], Awaitable[None]]


class SessionPipeline:
    """Owns the decode + transcribe loop for one capture session."""

    def __init__(
        self,
        decoder: Decoder,
        transcriber: IncrementalTranscriber,
        on_segments: OnSegments,
        interval_sec: float = 10.0,
        idle_interval_sec: float | None = None,
        watched: Callable[[], bool] | None = None,
    ):
        self.decoder = decoder
        self.transcriber = transcriber
        self._on_segments = on_segments
        self._interval = interval_sec
        # None (or no longer than the live interval): always live, whoever is watching
        self._idle_interval = idle_interval_sec
        self._watched = watched or (lambda: True)
        self._wake = asyncio.Event()
        # one worker per session: passes for a session are serialised, and a long pass
        # cannot occupy the shared default executor
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="louro-stt")
        self._worker: asyncio.Task | None = None
        self._stopped = False

    async def start(self) -> None:
        if self._worker is None:
            self._worker = asyncio.create_task(self._run())

    def nudge(self) -> None:
        """Someone started watching: catch up now instead of at the next batch."""
        self._wake.set()

    def feed(self, chunk: bytes) -> None:
        """Hand audio to the decoder. Returns without waiting for anything."""
        if self._stopped:
            return
        self.decoder.feed(chunk)

    async def stop(self) -> None:
        """Stop accepting audio, then transcribe whatever is left."""
        if self._stopped:
            return
        self._stopped = True

        if self._worker is not None:
            self._worker.cancel()
            try:
                await self._worker
            except asyncio.CancelledError:
                pass
            self._worker = None

        # closing joins the decoder thread, so keep it off the event loop
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(self._executor, self.decoder.close)

        await self._drain()
        self._executor.shutdown(wait=False)

    def _wait(self) -> float:
        idle = self._idle_interval is not None and self._idle_interval > self._interval
        return self._idle_interval if idle and not self._watched() else self._interval

    async def _run(self) -> None:
        loop = asyncio.get_running_loop()
        last = loop.time()
        while True:
            remaining = last + self._wait() - loop.time()
            if remaining > 0 and not self._wake.is_set():
                try:
                    await asyncio.wait_for(self._wake.wait(), timeout=remaining)
                except asyncio.TimeoutError:
                    pass
            # the wait may have changed meanwhile (a viewer came or went)
            if self._wake.is_set() or loop.time() >= last + self._wait():
                self._wake.clear()
                await self._catch_up()
                last = loop.time()

    async def _catch_up(self) -> None:
        """One pass, then more while a whole window or more is still waiting: after an
        idle batch, or when transcription fell behind."""
        window = getattr(self.transcriber, "window_samples", 0)
        for _ in range(_MAX_CATCH_UP_PASSES):
            await self._pass()
            if not window or self.transcriber.pending_samples < window:
                break

    async def _drain(self) -> None:
        """Catch up on any backlog with forced passes: no more audio is coming, so speech
        running into the end of the session is committed instead of held back."""
        for _ in range(_MAX_DRAIN_PASSES):
            if self.transcriber.pending_samples <= 0:
                break
            await self._pass(force=True)
        else:
            logger.warning(
                "Gave up draining after %d passes, %d samples left",
                _MAX_DRAIN_PASSES,
                self.transcriber.pending_samples,
            )

    async def _pass(self, force: bool = False) -> None:
        loop = asyncio.get_running_loop()
        try:
            segments = await loop.run_in_executor(self._executor, self.transcriber.step, force)
        except Exception as exc:
            logger.error("Transcription pass failed: %s", exc, exc_info=True)
            return

        if not segments:
            return
        try:
            await self._on_segments(segments)
        except Exception as exc:  # noqa: BLE001 - a dead subscriber must not end the session
            logger.warning("Broadcasting %d segments failed: %s", len(segments), exc)
