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
from urllib.parse import urljoin, urlsplit
import ipaddress
import re
import socket
import threading
import time

DEFAULT_ORIGINS = ("http://localhost:8000", "http://127.0.0.1:8000")
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}
PAIR = secrets.token_urlsafe(6)          # regenerated every start; printed once by announce()
_TOKEN = os.environ.get("NEURAL_STUDIO_TOKEN") or None


def announce() -> None:
    print(f"\n  Kundali pairing code: {PAIR}\n  (enter it in the web app; it is valid until this server stops)\n", flush=True)


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


# ---------------------------------------------------------------- busy state (one bench at a time)
_lock = threading.Lock()
_kind: str | None = None


class BusyError(Exception):
    """Raised when a bench is running; mapped to HTTP 409."""


def try_acquire(kind: str) -> bool:
    global _kind
    if not _lock.acquire(blocking=False):
        return False
    _kind = kind
    return True


def release() -> None:
    global _kind
    _kind = None
    try:
        _lock.release()
    except RuntimeError:
        pass


def busy() -> str | None:
    return _kind if _lock.locked() else None


def require_idle() -> None:
    """FastAPI dependency for endpoints that must not run during a benchmark."""
    if busy():
        raise BusyError("A benchmark is running. Try again when it finishes.")


# ---------------------------------------------------------------- SSRF-safe fetch (not wired to an endpoint yet)
MAX_REDIRECTS = 3
MAX_BYTES = 8 * 2**20
MAX_SECONDS = 15.0


class UnsafeURL(ValueError):
    pass


def _public(ip: str) -> bool:
    a = ipaddress.ip_address(ip.split("%")[0])
    if isinstance(a, ipaddress.IPv6Address) and a.ipv4_mapped:
        a = a.ipv4_mapped
    return a.is_global and not a.is_multicast


def resolve(host: str, port: int) -> list[str]:
    return [i[4][0] for i in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)]


def check_url(url: str, resolver=resolve) -> tuple[str, str, int, str, str]:
    """Validate and resolve. Returns (host, pinned_ip, port, path_and_query, normalised_url). Raises UnsafeURL."""
    if not isinstance(url, str) or not url or len(url) > 2048 or any(c in url for c in "\r\n\t \\"):
        raise UnsafeURL("Not a valid URL.")
    try:
        u = urlsplit(url)
        port = u.port or 443
    except ValueError:
        raise UnsafeURL("Not a valid URL.") from None
    if u.scheme.lower() != "https":
        raise UnsafeURL("Only https URLs are allowed.")
    if u.username is not None or u.password is not None or "@" in u.netloc:
        raise UnsafeURL("User names in URLs are not allowed.")
    host = (u.hostname or "").rstrip(".").lower()
    if not host or host == "localhost" or host.endswith(".localhost") or host.endswith(".local") or host.endswith(".internal"):
        raise UnsafeURL("That host is not allowed.")
    if re.fullmatch(r"[0-9a-fx.]+", host) and host[0].isdigit():
        try:
            ipaddress.ip_address(host)      # a plain dotted quad is judged below
        except ValueError:
            raise UnsafeURL("Numeric host forms such as 0x7f.1 or 2130706433 are not allowed.") from None
    try:                                    # a literal IP is checked as is
        ipaddress.ip_address(host)
        addrs = [host]
    except ValueError:
        try:
            addrs = resolver(host, port)
        except OSError:
            raise UnsafeURL("The host could not be resolved.") from None
    if not addrs or not all(_public(a) for a in addrs):
        raise UnsafeURL("That address is not public.")
    path = (u.path or "/") + (f"?{u.query}" if u.query else "")
    return host, addrs[0], port, path, url


def _open(ip: str, port: int, host: str, path: str, timeout: float, max_bytes: int, deadline: float):
    """One GET to the pinned IP (TLS verified against `host`). Returns (status, headers, body)."""
    import urllib3
    pool = urllib3.HTTPSConnectionPool(ip, port=port, server_hostname=host, assert_hostname=host, cert_reqs="CERT_REQUIRED",
                                       timeout=urllib3.Timeout(connect=5, read=min(timeout, 10)), retries=False)
    try:
        r = pool.urlopen("GET", path, headers={"Host": host if port == 443 else f"{host}:{port}", "User-Agent": "kundali/0.1"},
                         redirect=False, retries=False, preload_content=False)
        body = bytearray()
        try:
            for chunk in r.stream(65536):
                body += chunk
                if len(body) > max_bytes:
                    raise UnsafeURL("The response is too large.")
                if time.monotonic() > deadline:
                    raise UnsafeURL("The download took too long.")
        finally:
            r.release_conn()
        return r.status, {k.lower(): v for k, v in r.headers.items()}, bytes(body)
    finally:
        pool.close()


def safe_fetch(url: str, max_bytes: int = MAX_BYTES, seconds: float = MAX_SECONDS, resolver=resolve, opener=_open) -> bytes:
    deadline = time.monotonic() + seconds
    for _hop in range(MAX_REDIRECTS + 1):
        host, ip, port, path, norm = check_url(url, resolver)
        status, headers, body = opener(ip, port, host, path, seconds, max_bytes, deadline)
        if status in (301, 302, 303, 307, 308):
            loc = headers.get("location")
            if not loc:
                raise UnsafeURL("Bad redirect.")
            url = urljoin(norm, loc)
            continue
        if status != 200:
            raise UnsafeURL(f"The server answered HTTP {status}.")
        return body
    raise UnsafeURL("Too many redirects.")
