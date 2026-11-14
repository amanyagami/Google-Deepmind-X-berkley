"""Server-wide busy state: one benchmark at a time, and no model run while it measures."""
from __future__ import annotations

import threading

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
