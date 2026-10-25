"""Keeping a local, unauthenticated API out of reach of the web pages you visit.

The browser extension is the only intended caller. CORS only governs what a page may
read over HTTP, so the rest is enforced here:

- DNS rebinding: a hostile domain resolving to 127.0.0.1 is same-origin to its page,
  so every request must name this machine in its Host header;
- "simple" POSTs: a text/plain body skips the CORS preflight, so a body must be
  declared JSON, which makes the browser ask first;
- WebSockets, which CORS does not cover at all: see refuse_websocket;
- session ids become file names, so they are checked before they reach the disk.
"""
from __future__ import annotations

import re

from fastapi import FastAPI, Request, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import config

ALLOWED_ORIGINS = re.compile(
    r"^(chrome-extension://[a-z]+|moz-extension://[0-9a-f-]+|http://(127\.0\.0\.1|localhost)(:\d+)?)$"
)
ALLOWED_HOSTS = {"127.0.0.1", "localhost", "[::1]"} | {
    host.strip().lower() for host in config.EXTRA_HOSTS.split(",") if host.strip()
}
SESSION_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def host_allowed(host_header: str) -> bool:
    host = host_header.strip().lower()
    if host.startswith("["):  # [::1]:8877
        host = host.split("]")[0] + "]"
    else:
        host = host.split(":")[0]
    return host in ALLOWED_HOSTS


def install(app: FastAPI) -> None:
    """Add the CORS policy and the local-only checks to every HTTP request."""
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=ALLOWED_ORIGINS.pattern,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        if not host_allowed(request.headers.get("host", "")):
            return JSONResponse({"detail": "unknown host"}, status_code=400)
        has_body = request.headers.get("content-length") != "0"
        if request.method in ("POST", "PUT", "PATCH") and has_body:
            content_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
            if content_type != "application/json":
                return JSONResponse({"detail": "expected application/json"}, status_code=415)
        return await call_next(request)


async def refuse_websocket(websocket: WebSocket, session_id: str | None = None) -> bool:
    """Close a WebSocket that a web page opened, or one aimed outside the data folder.

    Browsers always send an Origin on a WebSocket; tools like curl send none and are fine.
    """
    origin = websocket.headers.get("origin")
    if not host_allowed(websocket.headers.get("host", "")) or (
        origin is not None and not ALLOWED_ORIGINS.match(origin)
    ):
        await websocket.close(code=4403, reason="origin not allowed")
        return True
    if session_id is not None and not SESSION_ID.match(session_id):
        await websocket.close(code=4400, reason="invalid session id")
        return True
    return False
