"""SSRF-safe fetch of a user-supplied URL. Not wired to an endpoint yet; use it for any future "paste a URL" input.

Rules: https only; no userinfo; the host is resolved once and every address must be public (no loopback, private,
link-local, reserved, multicast, or IPv4-mapped forms of those; numeric hosts such as 0x7f.1 or 2130706433 resolve to
127.0.0.1 and are refused); the connection goes to the pinned IP with the original host name for TLS and Host;
every redirect is re-validated the same way (at most 3); the body is capped in bytes and in seconds.
"""
from __future__ import annotations

import ipaddress
import re
import socket
import time
from urllib.parse import urljoin, urlsplit

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
        r = pool.urlopen("GET", path, headers={"Host": host if port == 443 else f"{host}:{port}", "User-Agent": "neural-studio/0.1"},
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
