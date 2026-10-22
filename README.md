# legacy — ghostmeet v0.1

The v0.1 line: a Chrome MV3 extension that streams tab and microphone audio to a local
FastAPI backend (faster-whisper), with an OpenClaw skill on top. Upstream's desktop app
(`app/`, `crates/`) replaces it from 0.2 and builds nothing new here; **this fork develops
it further** (see "About this fork" in the [main README](../README.md)). The benchmark
(`bench/`) still imports `backend/` to measure the v0.1 tail window.

```bash
cd legacy
python -m venv ../.venv && ../.venv/bin/python -m pip install -r requirements-dev.txt
../.venv/bin/python -m pytest tests/ -q          # 148 tests, no model, no network
node --test tests/extension/shared.test.mjs tests/extension/meet-dom.test.mjs
node tests/extension/verify-mic-and-reconnect.mjs   # real browser: microphone, reconnect
node tests/extension/verify-follow-call.mjs         # real browser: follow a Meet call
node tests/extension/verify-popup.mjs               # real browser: the popup
python3 tools/make_icons.py                         # redraw the extension icons
../.venv/bin/python -m backend                   # backend on 127.0.0.1:8877
./start.sh && ./stop.sh                          # or in the background (reads .env)
docker compose up -d                             # or in Docker, published on loopback only
```

Run from `legacy/`: the backend now keeps its recordings in `legacy/recordings/`
(gitignored). Recordings an older checkout made in the repository root are not moved.

Re-export every stored session as markdown (needs `GHOSTMEET_EXPORT_DIR`):

```bash
GHOSTMEET_EXPORT_DIR=~/meetings ../.venv/bin/python -m backend.exporter
```
