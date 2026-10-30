"""Subtitle credits that Whisper makes up in silence.

Whisper was trained on subtitled video, where the last lines are often the credits of
whoever made the subtitles. Given silence or background noise it can "finish" the audio
the same way ("Legendas pela comunidade Amara.org", "Obrigado por assistir"). A short
segment that contains one is the credit itself; a real sentence that happens to mention
one is long enough to stay.
"""

from __future__ import annotations

import re

# a segment this short that contains a credit is the credit, not speech around it
CREDIT_MAX_SEC = 4.0
CREDITS = re.compile(
    r"amara\.org|legendas? (pela|por)|legendado por|transcri[cç][aã]o (por|e legendas)|"
    r"obrigad[oa] por (assistir|ver)|inscreva-se|deixe (o )?seu like|"
    r"subtitles? by|thanks? for watching|please subscribe",
    re.IGNORECASE,
)


def is_credit(text: str, duration: float) -> bool:
    return duration <= CREDIT_MAX_SEC and bool(CREDITS.search(text))
