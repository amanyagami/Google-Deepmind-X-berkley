"""Who may talk to the companion.

A hostile page in another tab can send requests to 127.0.0.1. Defences, all checked before any work is done:
  * Host allowlist (DNS rebinding): only loopback names, plus NEURAL_STUDIO_HOSTS.
  * Origin allowlist: this server's own origin, http://localhost:8000, http://127.0.0.1:8000, plus the
    comma list in NEURAL_STUDIO_ORIGINS. Anything else (including "null") is refused: HTTP 403, WebSocket close 4403.
  * CORS and Private Network Access headers are sent only to allowed origins, echoing the origin (never "*").
  * Pairing: a one-time code printed at start must come in X-NS-Pair (HTTP) or in the WebSocket subprotocol
    "ns-pair.<code>" / first message {"pair": code}. The page this server serves itself (Origin == own origin, or a
    same-origin browser request) needs no code. NEURAL_STUDIO_TOKEN keeps working (X-Studio-Token) and, when set,
    is required even for the own origin. Compared with hmac.compare_digest. Never in URLs, never logged.
"""
from __future__ import annotations

import asyncio
import hmac
import os
import secrets
from dataclasses import dataclass

DEFAULT_ORIGINS = ("http://localhost:8000", "http://127.0.0.1:8000")
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}
PAIR = secrets.token_urlsafe(6)          # regenerated every start; printed once by announce()
_TOKEN = os.environ.get("NEURAL_STUDIO_TOKEN") or None


def announce() -> None:
    print(f"\n  Neural Studio pairing code: {PAIR}\n  (enter it in the web app; it is valid until this server stops)\n", flush=True)


def _split_env(name: str) -> set[str]:
    return {x.strip().rstrip("/").lower() for x in os.environ.get(name, "").split(",") if x.strip()}


def allowed_origins() -> set[str]:
    return set(DEFAULT_ORIGINS) | _split_env("NEURAL_STUDIO_ORIGINS")


def _hostname(host: str) -> str:
    h = host.strip().lower()
    if h.startswith("["):
        return h[1:].split("]")[0]
    return h.rsplit(":", 1)[0] if h.count(":") == 1 else h


def host_ok(host: str | None) -> bool:
    if not host:
        return False
    return _hostname(host) in (LOOPBACK_HOSTS | _split_env("NEURAL_STUDIO_HOSTS"))


def origin_allowed(origin: str, host: str | None) -> bool:
    o = origin.strip().rstrip("/").lower()
    if o in allowed_origins():
        return True
    return bool(host) and o in (f"http://{host.lower()}", f"https://{host.lower()}")


def _eq(a: str | None, b: str | None) -> bool:
    return bool(a) and bool(b) and hmac.compare_digest(a.encode(), b.encode())


def pair_ok(given: str | None, token: str | None = None) -> bool:
    return _eq(given, PAIR) or (_TOKEN is not None and _eq(token, _TOKEN))


@dataclass
class Verdict:
    status: int = 200
    message: str = ""
    cors_origin: str | None = None     # echo this in Access-Control-Allow-Origin, only when allowed
    needs_pair: bool = False

    @property
    def ok(self) -> bool:
        return self.status == 200


def classify(headers, protected: bool = True) -> Verdict:
    """Host + Origin verdict for a request or WebSocket handshake (headers: any case-insensitive mapping)."""
    host = headers.get("host")
    if not host_ok(host):
        return Verdict(403, "Host not allowed.")
    origin = headers.get("origin")
    if origin is not None:
        if not origin_allowed(origin, host):
            return Verdict(403, "Origin not allowed.")
        own = origin.strip().rstrip("/").lower() in (f"http://{host.lower()}", f"https://{host.lower()}")
        return Verdict(200, cors_origin=origin.strip().rstrip("/"), needs_pair=(not own) or _TOKEN is not None)
    same = (headers.get("sec-fetch-site") or "").lower() in ("same-origin", "none")
    return Verdict(200, needs_pair=protected and (not same or _TOKEN is not None))


def cors_headers(origin: str | None, preflight: bool = False, pna: bool = False) -> dict:
    if not origin:
        return {}
    h = {"Access-Control-Allow-Origin": origin, "Vary": "Origin", "Access-Control-Allow-Private-Network": "true"}
    if preflight:
        h.update({"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                  "Access-Control-Allow-Headers": "Content-Type, X-NS-Pair, X-Studio-Token", "Access-Control-Max-Age": "600"})
    return h


# ------------------------------------------------------------------------------------------ WebSocket
async def _close(ws, code: int, reason: str) -> None:
    try:
        await ws.accept()
        await ws.close(code=code, reason=reason)
    except Exception:  # noqa: BLE001
        pass


def _subprotocol_pair(ws) -> tuple[bool, str | None]:
    offered = ws.scope.get("subprotocols") or []
    code = next((p[len("ns-pair."):] for p in offered if p.startswith("ns-pair.")), None)
    return ("ns-v1" in offered), code


async def ws_gate(ws, first_timeout: float = 0.0):
    """Check Host/Origin/pairing and accept. Returns (ok, first_message_or_None).
    `{"type":"auth","pair":...}` messages are consumed here; any other first message is returned to the caller
    (its `pair` field, when needed, is checked here). None means no message arrived within first_timeout."""
    v = classify(ws.headers, protected=True)
    if not v.ok:
        await _close(ws, 4403, v.message)
        return False, None
    paired = not v.needs_pair
    has_v1, sub_code = _subprotocol_pair(ws)
    if not paired and sub_code is not None:
        if not pair_ok(sub_code):
            await _close(ws, 4401, "Pairing required.")
            return False, None
        paired = True
    await ws.accept(subprotocol="ns-v1" if has_v1 else None)
    deadline = 5.0 if not paired else first_timeout
    first = None
    while True:
        if deadline <= 0:
            break
        try:
            m = await asyncio.wait_for(ws.receive_json(), deadline)
        except asyncio.TimeoutError:
            break
        except Exception:  # noqa: BLE001 - closed or not JSON
            if not paired:
                await ws.close(code=4401, reason="Pairing required.")
                return False, None
            return False, None
        if not isinstance(m, dict):
            await ws.close(code=1003, reason="Bad message.")
            return False, None
        if not paired:
            if not pair_ok(m.get("pair"), m.get("token")):
                await ws.close(code=4401, reason="Pairing required.")
                return False, None
            paired = True
        m.pop("pair", None)
        m.pop("token", None)
        if m.get("type") == "auth":
            deadline = first_timeout
            continue
        first = m
        break
    if not paired:
        await ws.close(code=4401, reason="Pairing required.")
        return False, None
    return True, first
