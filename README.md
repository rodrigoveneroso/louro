# legacy/ — the extension and the backend

Everything this fork works on lives here; the main [README](../README.md) explains what
it does and how to install it. Upstream keeps this as its frozen v0.1 (tag `v0.1.0`)
while it builds a desktop app; the benchmark in `../bench/` still imports `backend/`.

```bash
./install.sh                                        # set up, start at login
./doctor.sh                                         # what is wrong, and how to fix it
./start.sh  /  ./stop.sh                            # by hand (through the service if any)
./run.sh                                            # in the foreground

../.venv/bin/python -m pip install -r requirements-dev.txt
../.venv/bin/python -m pytest tests/ -q            # backend suite, no model, no network
node --test tests/extension/shared.test.mjs tests/extension/meet-dom.test.mjs \
  tests/extension/echo-gate.test.mjs tests/extension/overlay-state.test.mjs
node tests/extension/verify-popup.mjs              # and the other verify-*.mjs: real browser

GHOSTMEET_EXPORT_DIR=~/meetings ../.venv/bin/python -m backend.exporter   # re-export all
../.venv/bin/python tools/bench_whisper.py speech.wav reference.txt      # pick a model
python3 tools/make_icons.py                                              # redraw the icons
```

Sessions live in `recordings/` (gitignored) unless `GHOSTMEET_DATA_DIR` says otherwise.
