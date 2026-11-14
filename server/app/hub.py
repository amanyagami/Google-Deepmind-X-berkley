"""Hugging Face Hub access: config.json, file list and safetensors headers via HTTP Range.

Nothing here downloads model weights. The probe reads two small byte ranges per
safetensors file (8 bytes, then the JSON header). `read_tensor_rows` fetches a bounded
overview of a single tensor that the UI asks to see.
"""
from __future__ import annotations

import json
import os
import re
import struct
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

import numpy as np
import requests

HF = "https://huggingface.co"
PICKLE_EXT = (".bin", ".pt", ".pth", ".ckpt", ".pkl")

MAX_RANGE_BYTES = 32 * 2**20      # one fetch_range call never reads more than this
MAX_RANGE_SECONDS = 30.0          # ... nor takes longer than this
MAX_HEADER_BYTES = 16 * 2**20
MAX_SHARDS = 512
WORKERS = 4                       # concurrent Hub requests
MAX_READ_BYTES = 16 * 2**20       # per tensor request
MAX_ROW_RANGES = 96               # strided overview: at most this many row reads
READ_SECONDS = 15.0


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
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def note(self, what: str, nbytes: int) -> None:
        with self._lock:
            self.requests += 1
            self.bytes_read += nbytes
            if len(self.log) < 500:
                self.log.append({"what": what, "bytes": nbytes})


def _headers(extra: dict | None = None) -> dict:
    h = {"User-Agent": "neural-studio/0.1"}
    token = os.environ.get("HF_TOKEN")
    if token:
        h["Authorization"] = f"Bearer {token}"
    if extra:
        h.update(extra)
    return h


_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,95}")
_HF_URL = re.compile(r"^(https?://)?(www\.)?huggingface\.co/", re.I)


def parse_repo(text: str) -> str:
    """Accept 'org/name', 'name', or a huggingface.co URL; return 'org/name'.
    Bare ids are strict (1-2 parts of letters, digits, '.', '_', '-'); URLs may carry /tree/main, a query or a fragment."""
    if not isinstance(text, str):
        raise HubError(400, "Model id must be text.")
    s = text.strip()
    if not s:
        raise HubError(400, "Empty model id.")
    if len(s) > 300:
        raise HubError(400, "Model id is too long.")
    if _HF_URL.match(s):
        s = _HF_URL.sub("", s, count=1)
        s = re.split(r"[?#]", s)[0]
        parts = [p for p in s.split("/") if p][:2]
    else:
        parts = s.split("/")
    if not parts or len(parts) > 2 or not all(_ID.fullmatch(p) for p in parts):
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
    try:
        return r.json()
    except ValueError:
        raise HubError(502, f"{what}: the Hub returned something that is not JSON.") from None


def list_files(repo: str, stats: ReadStats | None = None) -> list[str]:
    info = get_json(f"{HF}/api/models/{repo}", "model info", stats)
    sib = info.get("siblings", []) if isinstance(info, dict) else []
    return [s["rfilename"] for s in sib if isinstance(s, dict) and isinstance(s.get("rfilename"), str)]


def classify_files(files: list[str]) -> dict:
    safet = [f for f in files if f.endswith(".safetensors")]
    pickle = [f for f in files if f.endswith(PICKLE_EXT)]
    gguf = [f for f in files if f.endswith(".gguf")]
    return {"safetensors": safet, "pickle": pickle, "gguf": gguf}


def fetch_range(url: str, start: int, end: int, what: str, stats: ReadStats | None = None, info: dict | None = None) -> bytes:
    """Read bytes start..end (inclusive). Capped at 32 MiB and 30 s per call; `info['total']` gets the file size if known."""
    need = end - start + 1
    if start < 0 or need <= 0 or need > MAX_RANGE_BYTES:
        raise HubError(400, f"{what}: request is larger than the {MAX_RANGE_BYTES >> 20} MiB limit.")
    deadline = time.monotonic() + MAX_RANGE_SECONDS
    r = requests.get(url, headers=_headers({"Range": f"bytes={start}-{end}"}), timeout=(10, 20), stream=True)
    try:
        _check(r, what)
        if info is not None:
            m = re.match(r"bytes \d+-\d+/(\d+)$", r.headers.get("Content-Range", ""))
            if m:
                info["total"] = int(m.group(1))
        buf = bytearray()
        for chunk in r.iter_content(65536):
            buf += chunk
            if time.monotonic() > deadline:
                raise HubError(504, f"{what}: took longer than {int(MAX_RANGE_SECONDS)} s.")
            if r.status_code == 200 and len(buf) >= end + 1:
                break
            if r.status_code == 206 and len(buf) >= need:
                break
        status = r.status_code
    finally:
        r.close()
    if status == 200:
        if start > 0:
            raise HubError(502, f"{what}: server ignored the Range header.")
        data = bytes(buf[start : end + 1])
    else:
        data = bytes(buf[:need])
    if len(data) < need:
        raise HubError(502, f"{what}: the file ended early.")
    if stats is not None:
        stats.note(what, len(data))
    return data


def _resolve_url(repo: str, filename: str, revision: str = "main") -> str:
    if not valid_filename(filename):
        raise HubError(400, "Unsafe file name.")
    return f"{HF}/{repo}/resolve/{revision}/{filename}"


# ---- safetensors header: the same rules as the web app's parseHeader
_DTYPE = {
    "F32": (np.float32, 4), "F16": (np.float16, 2), "BF16": (None, 2),
    "F64": (np.float64, 8), "I64": (np.int64, 8), "I32": (np.int32, 4), "I8": (np.int8, 1), "U8": (np.uint8, 1),
}


def parse_header(header_len: int, raw: bytes, file_size: int | None = None) -> dict:
    """Validate a safetensors JSON header; return {name: {dtype, shape, data_offsets}} (offsets relative to the data section).
    Rejects: length 0 or > 16 MiB, a non-object header or entry, missing fields, unknown dtype (I16, U16, BOOL, F8, ...),
    more than 8 dims, negative or non-integer dims, offsets outside the file, overlap, and size != prod(shape) * itemsize."""
    if not isinstance(header_len, int) or isinstance(header_len, bool) or header_len <= 0 or header_len > MAX_HEADER_BYTES:
        raise HubError(502, f"Implausible header length {header_len}.")
    if len(raw) != header_len:
        raise HubError(502, "Header is shorter than its declared length.")
    try:
        header = json.loads(raw)
    except ValueError:
        raise HubError(502, "Header is not valid JSON.") from None
    if not isinstance(header, dict):
        raise HubError(502, "Header is not an object.")
    header.pop("__metadata__", None)
    data_len = None if file_size is None else file_size - 8 - header_len
    if data_len is not None and data_len < 0:
        raise HubError(502, "Header is larger than the file.")
    spans = []
    out: dict = {}
    for name, e in header.items():
        nm = str(name)[:60]
        if not isinstance(e, dict):
            raise HubError(502, f"Tensor entry '{nm}' is not an object.")
        dt, shape, offs = e.get("dtype"), e.get("shape"), e.get("data_offsets")
        if dt is None or shape is None or offs is None:
            raise HubError(502, f"Tensor '{nm}' is missing dtype, shape or data_offsets.")
        if not isinstance(dt, str) or dt not in _DTYPE:
            raise HubError(502, f"Tensor '{nm}' has unsupported dtype {str(dt)[:12]!r}.")
        if not isinstance(shape, list) or len(shape) > 8:
            raise HubError(502, f"Tensor '{nm}' has more than 8 dimensions or a bad shape.")
        if any(isinstance(d, bool) or not isinstance(d, int) or d < 0 for d in shape):
            raise HubError(502, f"Tensor '{nm}' has a negative or non-integer dimension.")
        if not (isinstance(offs, list) and len(offs) == 2 and all(isinstance(x, int) and not isinstance(x, bool) for x in offs)):
            raise HubError(502, f"Tensor '{nm}' has bad data_offsets.")
        a, b = offs
        if a < 0 or b < a or (data_len is not None and b > data_len):
            raise HubError(502, f"Tensor '{nm}' points outside the file.")
        n = 1
        for d in shape:
            n *= d                       # Python ints: no overflow
        if b - a != n * _DTYPE[dt][1]:
            raise HubError(502, f"Tensor '{nm}': byte size does not match its shape.")
        if b > a:
            spans.append((a, b, nm))
        out[name] = {"dtype": dt, "shape": list(shape), "data_offsets": [a, b]}
    spans.sort()
    for (a1, b1, n1), (a2, b2, n2) in zip(spans, spans[1:]):
        if a2 < b1:
            raise HubError(502, f"Tensors '{n1}' and '{n2}' overlap.")
    return out


def read_safetensors_header(repo: str, filename: str, stats: ReadStats) -> tuple[dict, int]:
    url = _resolve_url(repo, filename)
    info: dict = {}
    n = struct.unpack("<Q", fetch_range(url, 0, 7, f"{filename} Range 0-7", stats, info))[0]
    if n <= 0 or n > MAX_HEADER_BYTES:
        raise HubError(502, f"{filename}: implausible header length {n}.")
    raw = fetch_range(url, 8, 8 + n - 1, f"{filename} Range 8-{7 + n}", stats)
    header = parse_header(n, raw, info.get("total"))
    for entry in header.values():
        entry["file"] = filename
    return header, n


_NAME = re.compile(r"[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*")


def valid_filename(name) -> bool:
    """A repo-relative file name: no '..', '//', backslash, absolute path or URL, '%', '?', '#' or control characters."""
    if not isinstance(name, str) or not name or len(name) > 200 or not _NAME.fullmatch(name):
        return False
    return all(p not in (".", "..") for p in name.split("/"))


def weight_map(idx) -> list[str]:
    """The sorted, de-duplicated shard names of a model.safetensors.index.json, each validated."""
    wm = idx.get("weight_map") if isinstance(idx, dict) else None
    if not isinstance(wm, dict) or not wm:
        raise HubError(502, "The weight index has no weight_map.")
    shards = set()
    for v in wm.values():
        if not valid_filename(v) or not v.endswith(".safetensors"):
            raise HubError(502, f"The weight index names an unsafe file: {str(v)[:60]!r}.")
        shards.add(v)
    if len(shards) > MAX_SHARDS:
        raise HubError(502, f"The model has more than {MAX_SHARDS} weight files.")
    return sorted(shards)


def read_all_headers(repo: str, files: list[str], stats: ReadStats) -> dict:
    """Return {tensor_name: {dtype, shape, data_offsets, file, base}}. Shard headers are read in parallel (4 at a time)."""
    kinds = classify_files(files)
    st = kinds["safetensors"]
    if not st:
        return {}
    if "model.safetensors" in st:
        shards = ["model.safetensors"]
    elif "model.safetensors.index.json" in files:
        idx = get_json(_resolve_url(repo, "model.safetensors.index.json"), "weight index", stats)
        shards = weight_map(idx)
    else:
        shards = st[:1]
    merged: dict = {}
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        results = list(ex.map(lambda sh: read_safetensors_header(repo, sh, stats), shards))
    for header, n in results:
        for name, e in header.items():
            e["base"] = 8 + n  # absolute offset where the data section starts
            merged[name] = e
    return merged


def itemsize(dtype: str) -> int:
    return _DTYPE.get(dtype, (None, 4))[1]


def _decode(buf: bytes, dtype: str) -> np.ndarray:
    if dtype == "BF16":
        u = np.frombuffer(buf, dtype=np.uint16).astype(np.uint32) << 16
        return u.view(np.float32)
    if dtype in _DTYPE and _DTYPE[dtype][0] is not None:
        return np.frombuffer(buf, dtype=_DTYPE[dtype][0]).astype(np.float32)
    raise HubError(400, f"Unsupported dtype {dtype} for preview.")


def read_tensor_rows(repo: str, entry: dict, max_rows: int, stats: ReadStats, i0: int | None = None) -> tuple[np.ndarray, int]:
    """A bounded overview of one tensor: at most 16 MiB and 15 s per request.
    2-D: evenly strided rows (not just the first N); one request when the tensor fits, else up to 96 row reads, wide rows
    cut to their first columns. 1-D: the first elements. 3-D and up: `i0` picks the slab along the first dimension (required)."""
    shape = list(entry["shape"])
    isz = itemsize(entry["dtype"])
    base = entry["base"] + entry["data_offsets"][0]
    url = _resolve_url(repo, entry["file"])
    if len(shape) >= 3:
        if i0 is None:
            raise HubError(400, f"A {len(shape)}-D tensor needs an index i0 along its first dimension (0 to {shape[0] - 1}).")
        if not isinstance(i0, int) or not 0 <= i0 < shape[0]:
            raise HubError(400, f"i0 must be between 0 and {shape[0] - 1}.")
        slab = 1
        for d in shape[1:]:
            slab *= d
        base += i0 * slab * isz
        shape = [shape[1], slab // shape[1]] if shape[1] else [0, 0]
    if len(shape) == 0:
        return _decode(fetch_range(url, base, base + isz - 1, "scalar", stats), entry["dtype"]).reshape(1, 1), 1
    if len(shape) == 1:
        n_el = max(1, min(shape[0], max_rows * 64, MAX_READ_BYTES // isz))
        return _decode(fetch_range(url, base, base + n_el * isz - 1, "tensor elements", stats), entry["dtype"]).reshape(1, n_el), 1
    rows, cols = shape
    if rows == 0 or cols == 0:
        raise HubError(400, "The tensor is empty.")
    row_b = cols * isz
    k = max(1, min(rows, max_rows))
    if rows * row_b <= MAX_READ_BYTES:          # the whole tensor in one request, then stride in memory
        buf = fetch_range(url, base, base + rows * row_b - 1, f"tensor {rows} rows", stats)
        arr = _decode(buf, entry["dtype"]).reshape(rows, cols)
        idx = np.unique(np.linspace(0, rows - 1, k).astype(np.int64))
        return arr[idx], len(idx)
    k = min(k, MAX_ROW_RANGES)
    use_cols = max(1, min(cols, MAX_READ_BYTES // (k * isz)))
    idx = np.unique(np.linspace(0, rows - 1, k).astype(np.int64))
    deadline = time.monotonic() + READ_SECONDS

    def one(r: int) -> np.ndarray:
        if time.monotonic() > deadline:
            raise HubError(504, "Reading the tensor took too long.")
        a = base + int(r) * row_b
        return _decode(fetch_range(url, a, a + use_cols * isz - 1, f"row {int(r)}", stats), entry["dtype"])

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        got = list(ex.map(one, idx))
    return np.stack(got), len(idx)


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
