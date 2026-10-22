"""ghostmeet backend — audio capture + incremental STT."""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import os
import re
from contextlib import asynccontextmanager
from functools import partial
from pathlib import Path
from typing import Dict, List

import uvicorn
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .decoder import StreamingWebmDecoder
from .exporter import export_session, remove_export
from .hooks import run_on_export
from .incremental import IncrementalTranscriber, Segment
from .models import Note, Session
from .pcm_store import PcmStore
from .pipeline import SessionPipeline
from .refine import final_model, transcribe_recording
from .retention import should_discard, worth_keeping
from .store import SessionStore, default_data_dir
from .transcriber import WhisperTranscriber, get_model
from .vocabulary import clean as clean_terms
from .vocabulary import configured_terms, hotwords

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

RECORDINGS_DIR = default_data_dir()
RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = RECORDINGS_DIR / "ghostmeet.db"

# config from env
WHISPER_MODEL = os.environ.get("GHOSTMEET_MODEL", "base")
WHISPER_DEVICE = os.environ.get("GHOSTMEET_DEVICE", "auto")
WHISPER_COMPUTE = os.environ.get("GHOSTMEET_COMPUTE_TYPE", "float32")
WHISPER_LANGUAGE = os.environ.get("GHOSTMEET_LANGUAGE") or None
CHUNK_INTERVAL = float(os.environ.get("GHOSTMEET_CHUNK_INTERVAL", "10"))
# how long a resumed capture waits for the dropped one to finish its final pass
RESUME_WAIT_SEC = 120.0

# state
sessions: Dict[str, Session] = {}
pipelines: Dict[str, SessionPipeline] = {}
transcript_subscribers: Dict[str, List[WebSocket]] = {}
# set once a capture handler is completely done, so a resumed capture can wait for it
capture_done: Dict[str, asyncio.Event] = {}
# sessions continued after a dropped connection: their transcript spans several pipelines
resumed: set[str] = set()
# per live session: the transcriber, your vocabulary and the participants seen so far
vocabularies: Dict[str, dict] = {}
store: SessionStore | None = None


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global store
    store = SessionStore(DB_PATH)
    pipelines.clear()
    sessions.clear()
    sessions.update(store.load_sessions())
    # nothing is capturing yet, so anything left mid-flight died with the last process
    for session in sessions.values():
        if session.status in ("streaming", "transcribing"):
            session.status = "interrupted"
    logger.info("Loaded %d session(s) from %s", len(sessions), DB_PATH)
    try:
        yield
    finally:
        store.close()
        store = None


app = FastAPI(title="ghostmeet-backend", version="0.5.0", lifespan=lifespan)

# The API has no authentication, so the browser extension is the only intended caller.
# Echoing back any Origin let any page the user visited read their meeting transcripts.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(chrome-extension://[a-z]+|moz-extension://[0-9a-f-]+|http://(127\.0\.0\.1|localhost)(:\d+)?)$",
    allow_methods=["*"],
    allow_headers=["*"],
)


def _make_final_transcribe_fn(language: str | None) -> WhisperTranscriber:
    """The transcriber of the second pass after the meeting (see refine.py)."""
    model = get_model(final_model(), WHISPER_DEVICE, WHISPER_COMPUTE)
    return WhisperTranscriber(model, language=language)


def _make_transcribe_fn(language: str | None) -> WhisperTranscriber:
    """Build a per-session transcriber over the process-wide shared model."""
    model = get_model(WHISPER_MODEL, WHISPER_DEVICE, WHISPER_COMPUTE)
    return WhisperTranscriber(model, language=language)


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "service": "ghostmeet-backend",
        "model": WHISPER_MODEL,
        "chunk_interval_sec": CHUNK_INTERVAL,
    }


@app.get("/api/sessions")
def list_sessions():
    return {
        "count": len(sessions),
        "sessions": {k: v.to_dict() for k, v in sessions.items()},
    }


@app.get("/api/sessions/{session_id}")
def get_session(session_id: str):
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="session not found")
    return sessions[session_id].to_dict()


def _segments_for(session_id: str) -> List[Segment]:
    """Live sessions answer from the pipeline producing them, finished ones from disk."""
    if session_id in pipelines and session_id not in resumed:
        return pipelines[session_id].transcriber.transcript
    return store.load_segments(session_id)


@app.get("/api/sessions/{session_id}/transcript")
def get_transcript(session_id: str):
    if session_id not in pipelines and session_id not in sessions:
        raise HTTPException(status_code=404, detail="session not found")
    segments = _segments_for(session_id)
    return {
        "session_id": session_id,
        "segments": [s.to_dict() for s in segments],
        "full_text": " ".join(s.text for s in segments),
        "segment_count": len(segments),
    }


_SESSION_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_MAX_SPEAKER_EVENTS = 500


@app.post("/api/sessions/{session_id}/speaker-events")
async def add_speaker_events(session_id: str, request: Request):
    """Raw per-participant UI changes seen in the meeting page, kept as JSON lines.

    Which change means "is speaking" is worked out afterwards by lining these up with the
    transcript, so nothing is interpreted here.
    """
    if not _SESSION_ID.match(session_id):
        raise HTTPException(status_code=400, detail="invalid session id")
    body = await request.json()
    events = body.get("events") if isinstance(body, dict) else None
    if not isinstance(events, list) or len(events) > _MAX_SPEAKER_EVENTS:
        raise HTTPException(status_code=400, detail="expected a list of at most 500 events")
    path = RECORDINGS_DIR / f"{session_id}.speakers.jsonl"
    with path.open("a", encoding="utf-8") as out:
        for event in events:
            if isinstance(event, dict):
                out.write(json.dumps(event, ensure_ascii=False) + "\n")
    return {"stored": len(events)}


_MAX_MEETING_FIELD = 200


@app.post("/api/sessions/{session_id}/meeting")
async def set_meeting_info(session_id: str, request: Request):
    """Name and code of the meeting being captured, as the meeting page shows them."""
    session = sessions.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="expected an object")
    for field, attr in (("title", "title"), ("code", "meeting_code")):
        value = body.get(field)
        if value is None:
            continue
        if not isinstance(value, str) or len(value) > _MAX_MEETING_FIELD:
            raise HTTPException(status_code=400, detail=f"{field} must be a short string")
        setattr(session, attr, value.strip() or None)
    store.save_session(session)
    participants = body.get("participants")
    if participants is not None:
        if not isinstance(participants, list) or len(participants) > _MAX_PARTICIPANTS:
            raise HTTPException(status_code=400, detail="participants must be a short list")
        _hint_participants(session_id, clean_terms(participants))
    return {"title": session.title, "meeting_code": session.meeting_code}


_MAX_PARTICIPANTS = 100


def _hint_participants(session_id: str, names: List[str]) -> None:
    """Tell the live transcriber who is in the meeting, so it spells their names."""
    vocabulary = vocabularies.get(session_id)
    if vocabulary is None:
        return
    vocabulary["participants"] = clean_terms(vocabulary["participants"] + names)
    _apply_vocabulary(vocabulary)


def _apply_vocabulary(vocabulary: dict) -> None:
    transcribe = vocabulary["transcribe"]
    if hasattr(transcribe, "hotwords"):
        transcribe.hotwords = hotwords(vocabulary["terms"], vocabulary["participants"])
        logger.info(
            "Vocabulary: %d of your terms, %d participants",
            len(vocabulary["terms"]),
            len(vocabulary["participants"]),
        )


_MAX_NOTE = 1000


@app.post("/api/sessions/{session_id}/notes")
async def add_note(session_id: str, request: Request):
    """Mark the current moment of a meeting, optionally with a note.

    `at` is the moment in epoch milliseconds (default: now), so a mark lands where you
    pressed it even if the request takes a while.
    """
    session = sessions.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session not found")
    body = await request.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="expected an object")
    text, at = body.get("text", ""), body.get("at")
    if not isinstance(text, str) or len(text) > _MAX_NOTE:
        raise HTTPException(status_code=400, detail="text must be a string of at most 1000")
    if at is not None and not isinstance(at, (int, float)):
        raise HTTPException(status_code=400, detail="at must be epoch milliseconds")
    moment = at / 1000.0 if at is not None else dt.datetime.now().timestamp()
    started = dt.datetime.fromisoformat(session.started_at).timestamp()
    note = Note(at_sec=round(max(0.0, moment - started), 2), text=" ".join(text.split()))
    store.add_note(session_id, note)
    return {"at_sec": note.at_sec, "text": note.text}


@app.get("/api/sessions/{session_id}/notes")
def get_notes(session_id: str):
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="session not found")
    return {"notes": [{"at_sec": n.at_sec, "text": n.text} for n in store.load_notes(session_id)]}


@app.websocket("/ws/transcript/{session_id}")
async def ws_transcript(websocket: WebSocket, session_id: str):
    await websocket.accept()
    transcript_subscribers.setdefault(session_id, []).append(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        subscribers = transcript_subscribers.get(session_id, [])
        if websocket in subscribers:
            subscribers.remove(websocket)


async def _broadcast_segments(session_id: str, offset: float, segments: List[Segment]) -> None:
    # A resumed capture starts a new recording, timed from zero. Moving its segments to
    # the session clock keeps one timeline across reconnections (and the speaker log,
    # which uses wall time, lined up with it).
    for segment in segments:
        segment.start += offset
        segment.end += offset

    # persist first: captions are nice to have, a lost transcript is not recoverable
    store.add_segments(session_id, segments)

    session = sessions.get(session_id)
    if session is not None and session_id in pipelines:
        session.transcript_segments = len(_segments_for(session_id))
        store.save_session(session)

    subscribers = transcript_subscribers.get(session_id, [])
    payload = {"type": "transcript", "segments": [s.to_dict() for s in segments]}
    dead = []
    for ws in subscribers:
        try:
            await ws.send_json(payload)
        except Exception:  # noqa: BLE001 - a closed side panel is routine
            dead.append(ws)
    for ws in dead:
        subscribers.remove(ws)


@app.websocket("/ws/audio")
async def ws_audio(websocket: WebSocket):
    await websocket.accept()

    session_id = websocket.query_params.get("session") or dt.datetime.now().strftime(
        "%Y%m%d-%H%M%S"
    )
    language = websocket.query_params.get("lang") or WHISPER_LANGUAGE
    resume_ms = _resume_param(websocket.query_params.get("resume"))
    previous = sessions.get(session_id)

    if resume_ms is not None and previous is not None:
        # The extension lost its connection and came back with a new recorder. Let the
        # old handler finish its final pass first, so the two never share the session.
        previous_done = capture_done.get(session_id)
        if previous_done is not None:
            try:
                await asyncio.wait_for(previous_done.wait(), timeout=RESUME_WAIT_SEC)
            except asyncio.TimeoutError:
                await websocket.close(code=4409, reason="previous capture still finishing")
                return
    elif session_id in pipelines and previous is not None and previous.status == "streaming":
        logger.warning("Rejected duplicate capture for active session %s", session_id)
        await websocket.close(code=4409, reason="session already capturing")
        return

    pcm_path = RECORDINGS_DIR / f"{session_id}.pcm"
    # a re-used id starts fresh: appending to a previous recording corrupts both files
    pcm_path.unlink(missing_ok=True)

    offset = 0.0
    if resume_ms is not None and previous is not None:
        session = previous
        offset = _resume_offset(session, resume_ms)
        session.status, session.stopped_at, session.error = "streaming", None, None
        resumed.add(session_id)
        logger.info("Resuming session %s at %.1fs", session_id, offset)
    else:
        session = Session(
            session_id=session_id,
            language=language,
        )
        resumed.discard(session_id)
    sessions[session_id] = session
    store.save_session(session)
    done = capture_done[session_id] = asyncio.Event()

    pcm = PcmStore(pcm_path)
    decoder = StreamingWebmDecoder(pcm)
    transcribe = _make_transcribe_fn(language)
    vocabulary = vocabularies.setdefault(session_id, {"participants": []})
    vocabulary.update(transcribe=transcribe, terms=configured_terms())
    _apply_vocabulary(vocabulary)
    pipeline = SessionPipeline(
        decoder=decoder,
        transcriber=IncrementalTranscriber(pcm, transcribe),
        on_segments=partial(_broadcast_segments, session_id, offset),
        interval_sec=CHUNK_INTERVAL,
    )
    pipelines[session_id] = pipeline
    await pipeline.start()

    await websocket.send_json({"session_id": session_id})

    stopped_by_client = False
    refining = False
    try:
        try:
            while True:
                message = await websocket.receive()
                if message.get("bytes"):
                    chunk = message["bytes"]
                    session.chunks += 1
                    session.audio_bytes += len(chunk)
                    pipeline.feed(chunk)  # returns immediately
                elif message.get("text") == "stop":
                    stopped_by_client = True
                    break
                elif message.get("type") == "websocket.disconnect":
                    break
        except WebSocketDisconnect:
            pass

        session.status = "transcribing"
        await pipeline.stop()

        if decoder.error is not None:
            session.status = "error"
            session.error = str(decoder.error)
        else:
            session.status = "stopped"

        session.stopped_at = dt.datetime.now().isoformat(timespec="seconds")
        segments = _segments_for(session_id)
        session.transcript_segments = len(segments)
        session.duration_sec = round(offset + pcm.duration, 2)
        if should_discard(session, segments, stopped_by_client):
            _discard(session)
        else:
            # A resumed session's earlier stretches are no longer on disk, so only a
            # capture recorded in one go can be transcribed again as a whole.
            refining = (
                final_model() is not None
                and stopped_by_client
                and session_id not in resumed
                and worth_keeping(session, segments)
            )
            if refining:
                session.status = "refining"
            store.save_session(session)
            if worth_keeping(session, segments):
                path = _export(session, segments)
                if not refining:
                    _on_export(session, path)
    finally:
        # Always release the handle and reclaim the working file, even if the client
        # vanished or a pass blew up mid-session. Order matters: the decoder writes into
        # the PCM store from its own thread, so it has to be stopped first.
        decoder.close()
        pcm.close()
        # Audio is never kept: the PCM is only a working file, removed now or, when a
        # second pass is due, as soon as that pass has read it.
        if not refining:
            pcm_path.unlink(missing_ok=True)
            vocabularies.pop(session_id, None)
        done.set()

    # tell the client the final pass is done, so it knows the transcript is complete.
    # The socket may already be gone, which is fine.
    try:
        await websocket.send_json(
            {
                "type": "complete",
                "session_id": session_id,
                "status": session.status,
                "segment_count": session.transcript_segments,
                "duration_sec": session.duration_sec,
                "refining": refining,
            }
        )
    except Exception:  # noqa: BLE001 - client hung up first
        logger.debug("Could not send completion notice for %s", session_id)

    if refining:
        # after the notice: the live transcript is complete and usable meanwhile
        _background(_refine(session, pcm_path, language))

    logger.info(
        "Session %s complete: %d chunks, %d bytes, %.0fs audio, %d segments",
        session_id,
        session.chunks,
        session.audio_bytes,
        session.duration_sec,
        session.transcript_segments,
    )


def _export(session: Session, segments: List[Segment]) -> Path | None:
    try:
        return export_session(
            session,
            segments,
            speaker_events=RECORDINGS_DIR / f"{session.session_id}.speakers.jsonl",
            notes=store.load_notes(session.session_id),
        )
    except Exception:  # noqa: BLE001 - the markdown copy must never lose the session
        logger.exception("Could not export transcript for %s", session.session_id)
        return None


def _on_export(session: Session, path: Path | None) -> None:
    run_on_export(session, path, log_dir=RECORDINGS_DIR)


# tasks running after their capture handler returned; kept so they are not collected
_tasks: set[asyncio.Task] = set()


def _background(coroutine) -> None:
    task = asyncio.get_running_loop().create_task(coroutine)
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


async def _refine(session: Session, pcm_path: Path, language: str | None) -> None:
    """Transcribe the whole meeting again with the final model, then forget the audio."""
    session_id = session.session_id
    started = dt.datetime.now()
    try:
        transcribe = _make_final_transcribe_fn(language)
        vocabulary = vocabularies.get(session_id)
        if vocabulary is not None:
            vocabulary["transcribe"] = transcribe
            _apply_vocabulary(vocabulary)
        loop = asyncio.get_running_loop()
        segments = await loop.run_in_executor(None, transcribe_recording, pcm_path, transcribe)
        if segments:
            store.replace_segments(session_id, segments)
            logger.info(
                "Refined %s with %s in %.0fs: %d segments",
                session_id,
                final_model(),
                (dt.datetime.now() - started).total_seconds(),
                len(segments),
            )
    except Exception:  # noqa: BLE001 - the live transcript stays, which is fine
        logger.exception("Second pass failed for %s, keeping the live transcript", session_id)
    finally:
        pcm_path.unlink(missing_ok=True)
        vocabularies.pop(session_id, None)
        # the live pipeline's transcript is the old one now: read the stored one instead
        pipelines.pop(session_id, None)

    segments = store.load_segments(session_id)
    session.status = "stopped"
    session.transcript_segments = len(segments)
    store.save_session(session)
    _on_export(session, _export(session, segments))


def _discard(session: Session) -> None:
    """Forget a capture too short or too quiet to be a meeting, files included."""
    logger.info(
        "Discarding session %s: %.0fs, %d segments",
        session.session_id,
        session.duration_sec,
        session.transcript_segments,
    )
    session.status = "discarded"
    store.delete_session(session.session_id)
    sessions.pop(session.session_id, None)
    pipelines.pop(session.session_id, None)
    vocabularies.pop(session.session_id, None)
    resumed.discard(session.session_id)
    (RECORDINGS_DIR / f"{session.session_id}.speakers.jsonl").unlink(missing_ok=True)
    try:
        remove_export(session)
    except OSError:
        logger.exception("Could not remove the export of %s", session.session_id)


def _resume_param(raw: str | None) -> float | None:
    """`resume=<epoch ms>`: when the client's new recorder started."""
    if not raw:
        return None
    try:
        value = float(raw)
    except ValueError:
        return None
    return value if value > 0 else None


def _resume_offset(session: Session, resume_ms: float) -> float:
    """Seconds into the session where the resumed recording begins.

    Wall time since the session started, so the gap while disconnected stays a gap.
    Never earlier than what is already transcribed, in case the two clocks disagree.
    """
    started = dt.datetime.fromisoformat(session.started_at).timestamp()
    existing = store.load_segments(session.session_id)
    last_end = max((s.end for s in existing), default=0.0)
    return max(resume_ms / 1000.0 - started, last_end, 0.0)


def default_host() -> str:
    """Loopback unless asked otherwise — the API is unauthenticated."""
    return os.environ.get("GHOSTMEET_HOST", "127.0.0.1")


def run() -> None:
    port = int(os.environ.get("GHOSTMEET_PORT", "8877"))
    uvicorn.run(app, host=default_host(), port=port)
