---
name: ghostmeet
description: Read your meetings recorded by ghostmeet — sessions, live or finished transcripts with speaker names, and the marks and notes taken during them — and summarise them yourself.
metadata:
  {
    "openclaw": {
      "emoji": "👻",
      "requires": { "anyBins": ["curl"] }
    }
  }
---

# ghostmeet — your meetings, for your assistant

[ghostmeet](https://github.com/rodrigoveneroso/ghostmeet) records and transcribes meetings
locally (Chrome extension + Whisper). This skill reads what it recorded through its local
API. There is no summary endpoint: you summarise the transcript yourself, which keeps the
meeting on the user's machine and lets you answer whatever they actually asked.

## Prerequisites

The backend runs on the user's machine, on loopback only:

```bash
curl -s http://127.0.0.1:8877/api/health
```

Recording is started and stopped from the Chrome extension, not from here.

## API (read only, loopback)

```bash
curl -s http://127.0.0.1:8877/api/sessions                    # every session
curl -s http://127.0.0.1:8877/api/sessions/{id}               # one session: title, duration, status
curl -s http://127.0.0.1:8877/api/sessions/{id}/transcript    # segments + full_text
curl -s http://127.0.0.1:8877/api/sessions/{id}/notes         # marks and notes, at_sec on the session clock
```

Session ids are timestamps (`20261022-143519`), so the latest is the largest. Status
`streaming` means the meeting is still going; `refining` means a better transcript is on
its way and the current one is the live one.

If the user set `GHOSTMEET_EXPORT_DIR`, every finished meeting is also a markdown file
there (`YYYY-MM-DD_HHMM_<id>.md`), with speaker names (`[mm:ss] Name: text`, a line
without a name is someone who could not be identified) and the notes in place
(`📌 Momento marcado`, `📝 Nota: …`). Prefer that file when it exists.

## How to answer

- "Summarise my last meeting" → latest session's transcript and notes → write the summary:
  context, decisions, action items with owners and deadlines when said, open questions.
  Weigh the user's marks and notes most: they flagged those moments themselves.
- "What did we decide about X?" → search the transcripts for X, quote with timestamps.
- "How many meetings today?" → filter `/api/sessions` by `started_at`.

## Care

- Whisper misspells names and acronyms; say when a name looks wrong rather than guessing.
- Speaker names come from Google Meet's audio indicators and are estimates.
- Transcripts are private meeting content: never send them anywhere the user did not ask for.
