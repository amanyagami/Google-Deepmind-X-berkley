"""Hugging Face Hub access: config.json, file list and safetensors headers via HTTP Range.

Nothing here downloads model weights. The probe reads two small byte ranges per
safetensors file (8 bytes, then the JSON header). `read_tensor_rows` fetches only
the rows of a single tensor that the UI asks to see.
"""
from __future__ import annotations

import json
import os
import re
import struct
import time
from dataclasses import dataclass, field

import numpy as np
import requests

HF = "https://huggingface.co"
PICKLE_EXT = (".bin", ".pt", ".pth", ".ckpt", ".pkl")


class HubError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass
class ReadStats:
    requests: int = 0
    bytes_read: int = 0
    log: list = field(default_factory=list)

    def note(self, what: str, nbytes: int) -> None:
        self.requests += 1
        self.bytes_read += nbytes
        self.log.append({"what": what, "bytes": nbytes})


def _headers(extra: dict | None = None) -> dict:
    h = {"User-Agent": "neural-studio/0.1"}
    token = os.environ.get("HF_TOKEN")
    if token:
        h["Authorization"] = f"Bearer {token}"
    if extra:
        h.update(extra)
    return h


def parse_repo(text: str) -> str:
    """Accept 'org/name', 'name', or a full huggingface.co URL; return 'org/name'."""
    s = text.strip()
    s = re.sub(r"^https?://", "", s, flags=re.I)
    s = re.sub(r"^(www\.)?huggingface\.co/", "", s, flags=re.I)
    s = re.split(r"[?#]", s)[0]
    parts = [p for p in s.split("/") if p]
    if not parts:
        raise HubError(400, "Empty model id.")
    parts = parts[:2]
    # Hub ids are letters, digits, '.', '_' and '-' (anything else would end up inside request URLs)
    if not all(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,95}", p) for p in parts):
        raise HubError(400, f"'{text.strip()[:80]}' is not a Hugging Face model id (expected org/name).")
    if len(parts) == 1:
        return "openai-community/gpt2" if parts[0].lower() == "gpt2" else parts[0]
    return "/".join(parts)


def _check(r: requests.Response, what: str) -> None:
    if r.status_code in (401, 403):
        raise HubError(403, f"{what}: access denied. The model is gated or private. Set HF_TOKEN and accept its license.")
    if r.status_code == 404:
        raise HubError(404, f"{what}: not found on the Hub.")
    if r.status_code >= 400:
        raise HubError(502, f"{what}: Hub returned HTTP {r.status_code}.")


def get_json(url: str, what: str, stats: ReadStats | None = None) -> dict:
    r = requests.get(url, headers=_headers(), timeout=30)
    _check(r, what)
    if stats is not None:
        stats.note(what, len(r.content))
    return r.json()


def list_files(repo: str, stats: ReadStats | None = None) -> list[str]:
    info = get_json(f"{HF}/api/models/{repo}", "model info", stats)
    return [s["rfilename"] for s in info.get("siblings", [])]


def classify_files(files: list[str]) -> dict:
    safet = [f for f in files if f.endswith(".safetensors")]
    pickle = [f for f in files if f.endswith(PICKLE_EXT)]
    gguf = [f for f in files if f.endswith(".gguf")]
    return {"safetensors": safet, "pickle": pickle, "gguf": gguf}


def fetch_range(url: str, start: int, end: int, what: str, stats: ReadStats | None = None) -> bytes:
    need = end - start + 1
    r = requests.get(url, headers=_headers({"Range": f"bytes={start}-{end}"}), timeout=120, stream=True)
    _check(r, what)
    buf = bytearray()
    for chunk in r.iter_content(65536):
        buf += chunk
        if r.status_code == 200 and len(buf) >= end + 1:
            break
        if r.status_code == 206 and len(buf) >= need:
            break
    r.close()
    if r.status_code == 200:
        if start > 0:
            raise HubError(502, f"{what}: server ignored the Range header.")
        data = bytes(buf[start : end + 1])
    else:
        data = bytes(buf[:need])
    if stats is not None:
        stats.note(what, len(data))
    return data


def _resolve_url(repo: str, filename: str, revision: str = "main") -> str:
    return f"{HF}/{repo}/resolve/{revision}/{filename}"


def read_safetensors_header(repo: str, filename: str, stats: ReadStats) -> tuple[dict, int]:
    url = _resolve_url(repo, filename)
    n = struct.unpack("<Q", fetch_range(url, 0, 7, f"{filename} Range 0-7", stats))[0]
    if n <= 0 or n > 100_000_000:
        raise HubError(502, f"{filename}: implausible header length {n}.")
    raw = fetch_range(url, 8, 8 + n - 1, f"{filename} Range 8-{7 + n}", stats)
    header = json.loads(raw)
    header.pop("__metadata__", None)
    for entry in header.values():
        entry["file"] = filename
    return header, n


def read_all_headers(repo: str, files: list[str], stats: ReadStats) -> dict:
    """Return {tensor_name: {dtype, shape, data_offsets, file, base}}."""
    kinds = classify_files(files)
    st = kinds["safetensors"]
    if not st:
        return {}
    if "model.safetensors" in st:
        shards = ["model.safetensors"]
    elif "model.safetensors.index.json" in files:
        idx = get_json(_resolve_url(repo, "model.safetensors.index.json"), "weight index", stats)
        shards = sorted(set(idx["weight_map"].values()))
    else:
        shards = st[:1]
    merged: dict = {}
    for shard in shards:
        header, n = read_safetensors_header(repo, shard, stats)
        for name, e in header.items():
            e["base"] = 8 + n  # absolute offset where the data section starts
            merged[name] = e
    return merged


_DTYPE = {
    "F32": (np.float32, 4), "F16": (np.float16, 2), "BF16": (None, 2),
    "F64": (np.float64, 8), "I64": (np.int64, 8), "I32": (np.int32, 4), "I8": (np.int8, 1), "U8": (np.uint8, 1),
}


def itemsize(dtype: str) -> int:
    return _DTYPE.get(dtype, (None, 4))[1]


def _decode(buf: bytes, dtype: str) -> np.ndarray:
    if dtype == "BF16":
        u = np.frombuffer(buf, dtype=np.uint16).astype(np.uint32) << 16
        return u.view(np.float32)
    if dtype in _DTYPE and _DTYPE[dtype][0] is not None:
        return np.frombuffer(buf, dtype=_DTYPE[dtype][0]).astype(np.float32)
    raise HubError(400, f"Unsupported dtype {dtype} for preview.")


def read_tensor_rows(repo: str, entry: dict, max_rows: int, stats: ReadStats) -> tuple[np.ndarray, int]:
    """Fetch only the first `max_rows` rows of one tensor with a single Range request."""
    shape = entry["shape"]
    start, end = entry["data_offsets"]
    isz = itemsize(entry["dtype"])
    if len(shape) == 0:
        rows, row_elems = 1, 1
    else:
        rows = min(shape[0], max_rows)
        row_elems = int(np.prod(shape[1:])) if len(shape) > 1 else 1
        if len(shape) == 1:
            rows, row_elems = 1, min(shape[0], max_rows * 64)
    nbytes = rows * row_elems * isz
    if len(shape) > 1:
        nbytes = rows * row_elems * isz
    a = entry["base"] + start
    buf = fetch_range(_resolve_url(repo, entry["file"]), a, a + nbytes - 1, f"tensor {rows} rows", stats)
    arr = _decode(buf, entry["dtype"]).reshape(rows, row_elems)
    return arr, rows


def heatmap(arr: np.ndarray, size: int = 48) -> list[list[float]]:
    """Average-pool a 2D array down to at most size x size."""
    r, c = arr.shape
    br, bc = max(1, -(-r // size)), max(1, -(-c // size))
    pr, pc = (-r) % br, (-c) % bc
    padded = np.pad(arr, ((0, pr), (0, pc)), mode="edge")
    pooled = padded.reshape(padded.shape[0] // br, br, padded.shape[1] // bc, bc).mean(axis=(1, 3))
    return np.round(pooled, 4).tolist()


def timed(fn, *a, **k):
    t = time.perf_counter()
    out = fn(*a, **k)
    return out, round(time.perf_counter() - t, 3)
