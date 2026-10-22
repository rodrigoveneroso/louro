"""Which Whisper configuration to use on this machine: speed and accuracy, measured.

    ../.venv/bin/python tools/bench_whisper.py speech.wav reference.txt [--language pt]

`speech.wav` is any recording and `reference.txt` what is said in it. Without a real one
at hand, a local TTS makes a fine stand-in, e.g. Piper (https://github.com/rhasspy/piper):

    piper -m pt_BR-faber-medium.onnx -f speech.wav < reference.txt

Every configuration goes through the same settings the backend uses (30 s windows, voice
activity filter, no carried-over context) and reports the model's load time, how long the
recording took to transcribe (RTF: seconds of work per second of audio, lower is faster)
and the word error rate against the reference.
"""
from __future__ import annotations

import argparse
import re
import time
import unicodedata

import av
import numpy as np

RATE = 16000
WINDOW_SEC = 30


def load_audio(path: str) -> np.ndarray:
    container = av.open(path)
    resampler = av.AudioResampler(format="s16", layout="mono", rate=RATE)
    chunks = [
        frame.to_ndarray().ravel()
        for packet in container.decode(audio=0)
        for frame in resampler.resample(packet)
    ]
    return np.concatenate(chunks).astype(np.float32) / 32768


def words(text: str) -> list[str]:
    text = unicodedata.normalize("NFKD", text.lower())
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return re.findall(r"[a-z0-9]+", text)


def word_error_rate(reference: str, hypothesis: str) -> float:
    ref, hyp = words(reference), words(hypothesis)
    row = list(range(len(hyp) + 1))
    for i in range(1, len(ref) + 1):
        diagonal, row[0] = row[0], i
        for j in range(1, len(hyp) + 1):
            substitution = diagonal + (ref[i - 1] != hyp[j - 1])
            diagonal, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, substitution)
    return row[len(hyp)] / max(1, len(ref))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("audio")
    parser.add_argument("reference")
    parser.add_argument("--language", default="pt")
    parser.add_argument("--models", default="base,small", help="comma separated")
    parser.add_argument("--compute", default="auto,float32", help="comma separated")
    parser.add_argument("--hotwords", default=None, help="vocabulary to try, comma separated")
    args = parser.parse_args()

    from faster_whisper import WhisperModel

    audio = load_audio(args.audio)
    reference = open(args.reference, encoding="utf-8").read()
    seconds = len(audio) / RATE
    windows = [audio[i : i + WINDOW_SEC * RATE] for i in range(0, len(audio), WINDOW_SEC * RATE)]
    print(f"{seconds:.0f} s of audio, {len(words(reference))} words\n")
    header = f"{'model':8} {'compute':8} {'beam':>4} {'vocab':>5} | {'load':>6} {'work':>7} {'RTF':>5}"
    print(f"{header} | WER")

    for size in args.models.split(","):
        for compute in args.compute.split(","):
            for beam in (5, 1):
                for hotwords in (None, args.hotwords) if args.hotwords else (None,):
                    start = time.time()
                    model = WhisperModel(size, device="cpu", compute_type=compute)
                    load = time.time() - start
                    start = time.time()
                    text = []
                    for window in windows:
                        segments, _ = model.transcribe(
                            window,
                            language=args.language,
                            beam_size=beam,
                            hotwords=hotwords,
                            vad_filter=True,
                            vad_parameters=dict(
                                min_silence_duration_ms=500, speech_pad_ms=200, threshold=0.3
                            ),
                            condition_on_previous_text=False,
                        )
                        text += [s.text for s in segments]
                    work = time.time() - start
                    wer = word_error_rate(reference, " ".join(text))
                    print(
                        f"{size:8} {compute:8} {beam:>4} {'yes' if hotwords else 'no':>5} | "
                        f"{load:5.1f}s {work:6.1f}s {work / seconds:5.2f} | {wer * 100:4.1f}%"
                    )


if __name__ == "__main__":
    main()
