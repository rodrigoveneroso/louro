"""Local-only posture.

The backend serves meeting transcripts with no authentication, so the only thing
keeping them private is who can reach it. Binding every interface and echoing any
Origin put that on the network for anyone nearby.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import config


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "louro.db")
    with TestClient(app_module.app) as c:
        yield c


def test_default_bind_address_is_loopback(monkeypatch):
    """Regression: the default was 0.0.0.0, which exposed transcripts to the LAN."""
    monkeypatch.delenv("LOURO_HOST", raising=False)

    assert config.host() == "127.0.0.1"


def test_bind_address_can_still_be_overridden(monkeypatch):
    """Deliberate exposure stays possible, it just is not the default."""
    monkeypatch.setenv("LOURO_HOST", "0.0.0.0")

    assert config.host() == "0.0.0.0"


def test_the_extension_origin_is_allowed(client):
    origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"

    response = client.get("/api/health", headers={"Origin": origin})

    assert response.headers.get("access-control-allow-origin") == origin


def test_a_website_origin_is_not_allowed(client):
    """Regression: allow_origins=["*"] let any page a user visited read their meetings."""
    response = client.get("/api/health", headers={"Origin": "https://evil.example"})

    assert "access-control-allow-origin" not in response.headers


def test_preflight_from_a_website_origin_is_refused(client):
    response = client.options(
        "/api/sessions/x/notes",
        headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "POST",
        },
    )

    assert "access-control-allow-origin" not in response.headers


def test_preflight_from_the_extension_is_accepted(client):
    origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"

    response = client.options(
        "/api/sessions/x/notes",
        headers={"Origin": origin, "Access-Control-Request-Method": "POST"},
    )

    assert response.headers.get("access-control-allow-origin") == origin


def test_a_local_dashboard_origin_is_allowed(client):
    """Leaves room for a local web UI without reopening the door to the internet."""
    response = client.get("/api/health", headers={"Origin": "http://127.0.0.1:8877"})

    assert response.headers.get("access-control-allow-origin") == "http://127.0.0.1:8877"


def test_the_backend_never_calls_out():
    """Local-only is the whole point: no module of the backend may open a connection.

    A cloud summary used to live here; with it gone, nothing needs an HTTP client, and a
    new one appearing should be a deliberate decision, not an accident.
    """
    import ast
    from pathlib import Path

    clients = {"httpx", "requests", "aiohttp", "urllib.request", "http.client", "socket"}
    backend = Path(__file__).resolve().parent.parent / "backend"
    found = []
    for path in backend.glob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            names = []
            if isinstance(node, ast.Import):
                names = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module:
                names = [node.module]
            hits = [n for n in names if n in clients or n.split(".")[0] in clients]
            found += [f"{path.name}: {n}" for n in hits]

    assert found == []


# --- what a web page the user visits could otherwise do ------------------------------
# CORS only governs HTTP reads. Browsers let any page open a WebSocket to 127.0.0.1 and
# send "simple" POSTs to it, and DNS rebinding makes a hostile domain resolve to it.

EVIL = "https://evil.example"
EXTENSION = "chrome-extension://abcdefghijklmnopabcdefghijklmnop"


def _rejected(client, url, origin):
    from starlette.websockets import WebSocketDisconnect

    try:
        with client.websocket_connect(url, headers={"Origin": origin}) as ws:
            ws.receive_json()
    except WebSocketDisconnect as closed:
        return closed.code
    return None


def test_a_web_page_cannot_listen_to_a_live_transcript(client):
    assert _rejected(client, "/ws/transcript/any", EVIL) == 4403


def test_a_web_page_cannot_stream_audio_into_a_session(client):
    assert _rejected(client, "/ws/audio?session=planted", EVIL) == 4403
    assert "planted" not in client.get("/api/sessions").json()["sessions"]


def test_the_extension_still_connects(client):
    with client.websocket_connect("/ws/audio?session=fine", headers={"Origin": EXTENSION}) as ws:
        assert ws.receive_json()["session_id"] == "fine"
        ws.send_text("stop")
        ws.receive_json()


def test_a_session_id_cannot_point_outside_the_data_folder(client, tmp_path):
    assert _rejected(client, "/ws/audio?session=../../escaped", EXTENSION) == 4400
    assert not list(tmp_path.parent.glob("escaped*"))


def test_a_post_must_be_json_so_the_browser_has_to_ask_first(client):
    """A text/plain POST skips the CORS preflight, and used to be parsed anyway."""
    response = client.post(
        "/api/sessions/x/notes",
        content=b'{"text": "planted"}',
        headers={"Content-Type": "text/plain"},
    )

    assert response.status_code == 415


def test_a_request_for_another_host_is_refused(client):
    """DNS rebinding: a hostile domain that resolves to 127.0.0.1 reads as same-origin."""
    response = client.get("/api/sessions", headers={"Host": "evil.example"})

    assert response.status_code == 400
