# Security

Louro records private meetings, so the bar is: nothing leaves the machine, and nothing
on the machine other than Louro's own extension can read what it recorded.

## What protects a recording

| Threat | Defence | Tested in |
|---|---|---|
| Another device on the network | The backend binds `127.0.0.1` only | `test_security.py` |
| A web page reading the API | CORS allows Louro's extension only, never `*` | `test_security.py` |
| Another extension you installed reading the API | Louro's extension id is fixed by the key in its manifest, and only that id is allowed (`LOURO_EXTENSION_IDS` adds more) | `test_security.py` |
| A web page opening a WebSocket (CORS does not apply) | Origins other than the extension's are refused, so no page can listen to a live transcript or stream into a session | `test_security.py` |
| A web page sending a "simple" POST, which skips the CORS preflight | Request bodies must be `application/json`, which forces the preflight | `test_security.py` |
| DNS rebinding, a hostile domain resolving to `127.0.0.1` | Requests must address `127.0.0.1` or `localhost` (`LOURO_ALLOWED_HOSTS` adds more) | `test_security.py` |
| A session id escaping the data folder | Session ids are `[A-Za-z0-9_-]{1,64}` | `test_security.py` |
| The backend sending data out | It has no HTTP or socket client; a test fails if a backend module imports one | `test_security.py` |
| Audio lingering on disk | Only the transcript is stored; the working audio is deleted when a session ends (after the optional second pass) | `test_app.py` |
| Meeting content being executed | `LOURO_ON_EXPORT` gets the meeting's details in environment variables, never in its command line | `test_hooks.py` |
| Transcript text injected into a page | The extension only ever sets `textContent` with what the backend returns | |
| Meet pages learning about the extension | The one file Meet pages can load (the button's icon) is served under a per-session URL (`use_dynamic_url`) | |

The API has no authentication: anything that runs as your user on your machine can
read your meetings, as it could read any other file of yours.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting on this
repository (**Security**, then **Report a vulnerability**), with steps to reproduce.
