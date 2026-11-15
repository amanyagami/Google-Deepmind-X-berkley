"""The machine under the model: what it is, how busy it is, how fast each part really is,
and what one prompt costs it.

Everything returned here is measured or read from the OS. Where a number is derived
(FLOPs from tensor shapes, effective bandwidth = bytes / time) or estimated (theoretical peaks),
the field says so.
"""
from __future__ import annotations

import ctypes
import glob
import json
import math
import os
import platform
import statistics
import subprocess
import tempfile
import threading
import time

import numpy as np
import psutil
import requests
import torch

IS_WIN = platform.system() == "Windows"
_LOCK = threading.Lock()


# ----------------------------------------------------------------------------------------- info
def _ps(script: str) -> list[dict]:
    """Run PowerShell, return a list of dicts."""
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", f"{script} | ConvertTo-Json -Compress -Depth 3"],
                             capture_output=True, text=True, timeout=30)
        text = out.stdout.strip()
        if not text:
            return []
        data = json.loads(text)
        return data if isinstance(data, list) else [data]
    except Exception:  # noqa: BLE001 - hardware queries must never break the app
        return []


_SMBIOS = {20: "DDR", 21: "DDR2", 24: "DDR3", 26: "DDR4", 27: "LPDDR", 28: "LPDDR2", 29: "LPDDR3", 30: "LPDDR4", 34: "DDR5", 35: "LPDDR5"}
_INFO: dict | None = None


def _cpu_flops_per_cycle(vendor: str, cap: str) -> tuple[int, str]:
    """FP32 FLOPs per core per cycle = lanes x 2 (FMA) x FMA pipes. Estimates, stated as such."""
    if cap.startswith("AVX512"):
        if "AMD" in vendor.upper():
            return 32, "AVX-512 on AMD Zen 4 runs 512-bit ops as two 256-bit halves: 2 FMA pipes x 8 lanes x 2"
        return 64, "AVX-512: 2 FMA pipes x 16 lanes x 2"
    if cap.startswith("AVX2"):
        return 32, "AVX2: 2 FMA pipes x 8 lanes x 2"
    return 16, "assumed SSE: 1 pipe x 4 lanes x 2 x 2"


def info() -> dict:
    global _INFO
    if _INFO:
        return _INFO
    cores = psutil.cpu_count(logical=False) or 1
    threads = psutil.cpu_count(logical=True) or cores
    vm = psutil.virtual_memory()
    cap = torch.backends.cpu.get_cpu_capability()
    cpu = {"name": platform.processor(), "vendor": "", "cores": cores, "threads": threads, "base_mhz": None}
    caches, ram, gpus, disks, nics, links = {}, [], [], [], [], []
    if IS_WIN:
        p = (_ps("Get-CimInstance Win32_Processor | Select-Object Name,Manufacturer,MaxClockSpeed") or [{}])[0]
        cpu.update(name=(p.get("Name") or cpu["name"]).strip(), vendor=p.get("Manufacturer") or "", base_mhz=p.get("MaxClockSpeed"))
        for c in _ps("Get-CimInstance Win32_CacheMemory | Select-Object Level,InstalledSize"):
            lvl = {3: "L1", 4: "L2", 5: "L3"}.get(c.get("Level"))
            if lvl:
                caches[lvl] = caches.get(lvl, 0) + int(c.get("InstalledSize") or 0) * 1024
        ram = _ps("Get-CimInstance Win32_PhysicalMemory | Select-Object BankLabel,Capacity,Speed,ConfiguredClockSpeed,SMBIOSMemoryType")
        gpus = _ps("Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion")
        disks = _ps("Get-PhysicalDisk | Select-Object FriendlyName,MediaType,BusType,Size")
        nics = _ps("Get-NetAdapter | Where-Object Status -eq Up | Select-Object Name,InterfaceDescription,LinkSpeed")
        links = _ps("Get-PnpDevice -Class SCSIAdapter -PresentOnly | Where-Object FriendlyName -match 'NVM' | ForEach-Object { "
                    "$p = Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName DEVPKEY_PciDevice_CurrentLinkSpeed,DEVPKEY_PciDevice_CurrentLinkWidth; "
                    "[pscustomobject]@{ Name=$_.FriendlyName; Gen=$p[0].Data; Width=$p[1].Data } }")
    else:
        try:
            for line in open("/proc/cpuinfo"):
                if line.startswith("model name"):
                    cpu["name"] = line.split(":", 1)[1].strip()
                    break
        except OSError:
            pass
        f = psutil.cpu_freq()
        cpu["base_mhz"] = int(f.max) if f else None
    # per-core caches: L1/L2 totals are summed over cores, L3 is shared
    per_core = {k: v // cores for k, v in caches.items() if k in ("L1", "L2")}
    mhz = cpu["base_mhz"] or 3000
    fpc, why = _cpu_flops_per_cycle(cpu["vendor"], cap)
    sticks = [{"slot": r.get("BankLabel"), "gb": round((r.get("Capacity") or 0) / 2**30), "mts": r.get("ConfiguredClockSpeed") or r.get("Speed"),
               "type": _SMBIOS.get(r.get("SMBIOSMemoryType"), "RAM")} for r in ram]
    chans = len({(s["slot"] or "").split("CHANNEL")[-1].strip()[:1] for s in sticks if "CHANNEL" in (s["slot"] or "")}) or max(1, min(len(sticks), 2))
    mts = max([s["mts"] or 0 for s in sticks] or [0])
    ddr = sticks and sticks[0]["type"].startswith("DDR") and not sticks[0]["type"].startswith("LP")
    mem_peak = round(mts * 8 * chans / 1000, 1) if mts and ddr else None
    _INFO = {
        "os": platform.platform(), "python": platform.python_version(), "torch": torch.__version__,
        "cpu": {**cpu, "isa": cap, "threads_used": torch.get_num_threads(), "caches": caches, "per_core_cache": per_core,
                "flops_per_cycle": fpc, "flops_basis": why, "peak_gflops_est": round(cores * mhz / 1000 * fpc, 1),
                "peak_note": "all cores at base clock; real chips may boost higher"},
        "ram": {"total": vm.total, "sticks": sticks, "channels": chans, "mts": mts, "type": sticks[0]["type"] if sticks else None,
                "peak_gbps_est": mem_peak, "peak_note": "MT/s x 8 bytes x channels"},
        "gpus": [{"name": g.get("Name"), "driver": g.get("DriverVersion"),
                  "integrated": any(k in (g.get("Name") or "") for k in ("Radeon", "Intel", "UHD", "Iris")) and "RTX" not in (g.get("Name") or ""),
                  "used": False} for g in gpus],
        "disks": [{"name": d.get("FriendlyName"), "media": d.get("MediaType"), "bus": d.get("BusType"), "bytes": d.get("Size")} for d in disks],
        "nics": [{"name": n.get("InterfaceDescription"), "link": n.get("LinkSpeed")} for n in nics],
        "pcie": [_pcie(l) for l in links if l.get("Gen")],
        "power": _power_caps(cores),
        "source": "companion",
    }
    return _INFO


# PCIe: GT/s per lane by generation, and line-code efficiency (8b/10b up to Gen2, 128b/130b after)
_PCIE = {1: (2.5, 0.8), 2: (5.0, 0.8), 3: (8.0, 128 / 130), 4: (16.0, 128 / 130), 5: (32.0, 128 / 130)}


def _pcie(l: dict) -> dict:
    gen, width = int(l["Gen"]), int(l.get("Width") or 1)
    gts, eff = _PCIE.get(gen, (0, 1))
    return {"device": l.get("Name"), "gen": gen, "lanes": width, "gts": gts, "gbps": round(gts * eff * width / 8, 2),
            "note": f"PCIe Gen{gen} x{width}: {gts} GT/s per lane, theoretical one-way"}


def _power_caps(cores: int) -> dict:
    from . import power
    s = power.sample(cores)
    return {"measured": s.get("pkg_w") is not None, "per_core": bool(s.get("core_w")), "source": s.get("source"),
            "thermal_note": "ACPI thermal zone: a board sensor, not the CPU die"}


# ------------------------------------------------------------------------------------ telemetry
_prev: dict = {}
_PROC: psutil.Process | None = None


def _proc() -> psutil.Process:
    """One cached Process object: cpu_percent() measures since the previous call on the same object."""
    global _PROC
    if _PROC is None:
        _PROC = psutil.Process(os.getpid())
        _PROC.cpu_percent(None)
    return _PROC


def telemetry() -> dict:
    """One live sample. Rates come from OS counter deltas since the previous call."""
    now = time.time()
    per = psutil.cpu_percent(percpu=True)
    vm = psutil.virtual_memory()
    pr = _proc()
    dio, nio = psutil.disk_io_counters(), psutil.net_io_counters()
    f = psutil.cpu_freq()
    out = {"t": now, "cpu": per, "cpu_avg": round(sum(per) / len(per), 1), "mhz": f.current if f else None,
           "ram_used": vm.used, "ram_total": vm.total, "rss": pr.memory_info().rss, "proc_cores": round(pr.cpu_percent(None) / 100, 2)}
    if _prev:
        dt = max(1e-3, now - _prev["t"])
        out.update(disk_read_bps=(dio.read_bytes - _prev["dr"]) / dt, disk_write_bps=(dio.write_bytes - _prev["dw"]) / dt,
                   net_recv_bps=(nio.bytes_recv - _prev["nr"]) / dt, net_sent_bps=(nio.bytes_sent - _prev["ns"]) / dt)
    else:
        out.update(disk_read_bps=0, disk_write_bps=0, net_recv_bps=0, net_sent_bps=0)
    _prev.update(t=now, dr=dio.read_bytes, dw=dio.write_bytes, nr=nio.bytes_recv, ns=nio.bytes_sent)
    from . import power
    out["power"] = power.sample(psutil.cpu_count(logical=False) or 1)
    return out


class PowerRecorder:
    """Samples the power sensors in the background (20 Hz) and tags each sample with the running test."""

    def __init__(self, emit=None, hz: float = 20.0):
        from . import power
        self.power, self.emit, self.dt = power, emit, 1.0 / hz
        self.n = psutil.cpu_count(logical=False) or 1
        self.stage = "idle"
        self.samples: list[dict] = []
        self._stop = threading.Event()
        self.t0 = time.perf_counter()
        self.th = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        seq = self.power.sample(self.n).get("seq", 0)
        while not self._stop.is_set():
            s = self.power.wait_next(seq)
            if s.get("seq", 0) <= seq:
                continue
            seq = s["seq"]
            if s.get("pkg_w") is not None:
                util = psutil.cpu_percent(percpu=True)
                row = {"t": round(time.perf_counter() - self.t0, 3), "stage": self.stage, "pkg_w": s["pkg_w"], "core_w": s["core_w"],
                       "mhz": s["eff_mhz"], "throttle": s.get("throttle") or 0, "util": [round((util[2 * k] + util[2 * k + 1]) / 2 if len(util) >= 2 * self.n else util[k % len(util)], 1) for k in range(self.n)]}
                self.samples.append(row)
                if self.emit:
                    self.emit({"type": "power", **row})

    def __enter__(self):
        psutil.cpu_percent(percpu=True)
        self.th.start()
        return self

    def __exit__(self, *_):
        self._stop.set()
        self.th.join(timeout=1)

    def summary(self) -> dict:
        """Energy per test (trapezoid over the samples) and average/peak power."""
        by: dict[str, dict] = {}
        s = self.samples
        for a, b in zip(s, s[1:]):
            dt = b["t"] - a["t"]
            d = by.setdefault(a["stage"], {"joules": 0.0, "seconds": 0.0, "peak_w": 0.0, "core_j": [0.0] * len(a["core_w"])})
            # each interval belongs wholly to the sample that starts it, so a test's average never exceeds its peak
            d["joules"] += a["pkg_w"] * dt
            d["seconds"] += dt
            d["peak_w"] = max(d["peak_w"], a["pkg_w"])
            for k, x in enumerate(a["core_w"]):
                if x is not None:
                    d["core_j"][k] += x * dt
        thr = sum(1 for x in s if x.get("throttle"))
        if thr:
            by["_throttle"] = {"joules": 0.0, "seconds": thr * 0.1, "peak_w": 0.0, "core_j": []}
        return {k: {"joules": round(v["joules"], 2), "seconds": round(v["seconds"], 2), "avg_w": round(v["joules"] / v["seconds"], 2) if v["seconds"] else None,
                    "peak_w": round(v["peak_w"], 2), "core_j": [round(c, 2) for c in v["core_j"]]} for k, v in by.items()}


# ------------------------------------------------------------------------------- microbenchmarks
class Cancelled(Exception):
    """Raised at the next safe point after the client asked to stop."""


def _chk(cancel) -> None:
    if cancel is not None and cancel.is_set():
        raise Cancelled()


def _stats(xs: list[float], discard: int = 0) -> dict:
    """Median, a distribution-free 95% CI of the median, and spread, after discarding warm-up samples."""
    raw = list(xs)
    kept = raw[discard:] if len(raw) - discard >= 5 else raw
    s = sorted(kept)
    n = len(s)
    k = max(0, int(n / 2 - 0.98 * math.sqrt(n)))
    mean = statistics.mean(s)
    return {"n": n, "warmup_discarded": len(raw) - n, "min": round(s[0], 2), "median": round(statistics.median(s), 2), "max": round(s[-1], 2),
            "ci95": [round(s[k], 2), round(s[n - 1 - k], 2)],
            "cv_pct": round(100 * statistics.pstdev(s) / mean, 1) if n > 1 and mean else 0.0}


def _spread(xs: list[float]) -> dict:
    return _stats(xs, 0)


def _loop(op, per_op: float, seconds: float, cancel, cb=None, min_samples: int = 5, warmup: int = 1) -> tuple[list[float], int]:
    """Run `op` until there are warmup + min_samples samples and `seconds` have passed. Each op is short (<= ~50 ms),
    and `cancel` is checked between ops. Returns (rates in G-units/s, ops run)."""
    xs: list[float] = []
    t_all = time.perf_counter()
    best = 0.0
    while True:
        _chk(cancel)
        t = time.perf_counter()
        op()
        v = per_op / max(1e-9, time.perf_counter() - t) / 1e9
        xs.append(v)
        best = max(best, v)
        if cb:
            cb(v, best)
        el = time.perf_counter() - t_all
        if (len(xs) >= warmup + min_samples and el >= seconds) or len(xs) >= 400 or el > 3 * seconds + 2:
            return xs, len(xs)


def _matmul(nthreads: int, n: int, cb=None, seconds: float = 2.0, cancel=None, min_samples: int = 5) -> dict:
    old = torch.get_num_threads()
    torch.set_num_threads(nthreads)
    try:
        a, b = torch.randn(n, n), torch.randn(n, n)
        while True:  # keep one multiply under ~50 ms so a cancel lands quickly
            _chk(cancel)
            t = time.perf_counter()
            torch.mm(a, b)
            if time.perf_counter() - t <= 0.05 or n <= 128:
                break
            n = max(128, (n * 3 // 4) // 64 * 64)
            a, b = torch.randn(n, n), torch.randn(n, n)
        xs, ops = _loop(lambda: torch.mm(a, b), 2 * n**3, seconds, cancel, cb, min_samples)
        st = _stats(xs, 1)
        return {"gflops": round(max(xs), 1), "median": st["median"], "ci95": st["ci95"], "threads": nthreads, "n": n, "spread": st,
                "work": {"amount": round(2 * n**3 * (ops + 1) / 1e9, 2), "unit": "GFLOP"}}
    finally:
        torch.set_num_threads(old)


AI_REPO = "HuggingFaceTB/SmolLM2-135M"


def _ai_holder(repo: str = AI_REPO):
    from . import runner
    try:
        return runner.get_holder(repo)
    except Exception:  # noqa: BLE001 - the model may not be cached and the PC may be offline
        return None


def _ai(h, cb=None, n: int = 32, cancel=None) -> dict | None:
    """Tokens per second for a real small language model (greedy decoding with the KV cache)."""
    if h is None:
        return None
    repo = h.repo
    with h.lock, torch.no_grad():
        enc = h.tok("The capital of France is", return_tensors="pt")
        out = h.model(**enc, use_cache=True)
        pkv, nxt = out.past_key_values, out.logits[0, -1].argmax().view(1, 1)
        times = []
        for _ in range(n):
            _chk(cancel)
            t = time.perf_counter()
            o = h.model(input_ids=nxt, past_key_values=pkv, use_cache=True)
            dt = time.perf_counter() - t
            pkv, nxt = o.past_key_values, o.logits[0, -1].argmax().view(1, 1)
            times.append(dt)
            if cb:
                cb(1 / dt, 1 / min(times))
    tps = [1 / x for x in times]
    st = _stats(tps, 2)
    return {"tps": st["median"], "ci95": st["ci95"], "model": repo, "tokens": n, "spread": st, "work": {"amount": n, "unit": "tokens"}}


def _dram(cb=None, ram_mb: int = 480, seconds: float = 2.0, cancel=None, min_samples: int = 5) -> dict:
    n = max(1_000_000, int(ram_mb * 2**20 // 12))          # three float32 arrays
    a, b, c = torch.ones(n), torch.ones(n), torch.empty(n)
    c.fill_(0)
    xs, reads = [], []
    t_all = time.perf_counter()
    best = 0.0
    while True:
        _chk(cancel)
        t = time.perf_counter()
        torch.add(a, b, out=c)
        v = 12 * n / (time.perf_counter() - t) / 1e9
        xs.append(v)
        best = max(best, v)
        if cb:
            cb(v, best)
        t = time.perf_counter()
        a.sum()
        reads.append(4 * n / (time.perf_counter() - t) / 1e9)
        el = time.perf_counter() - t_all
        if (len(xs) >= 1 + min_samples and el >= seconds) or len(xs) >= 400 or el > 3 * seconds + 2:
            break
    st = _stats(xs, 1)
    return {"copy_gbps": round(max(xs), 1), "read_gbps": round(max(reads), 1), "median": st["median"], "ci95": st["ci95"],
            "array_mb": round(4 * n / 1e6), "spread": st, "work": {"amount": round(16 * n * len(xs) / 1e9, 2), "unit": "GB"}}


def _cache_curve(cb=None, max_kb: int = 262144, cancel=None, min_samples: int = 5) -> list[dict]:
    """Single-thread streaming bandwidth vs working-set size: plateaus show L1, L2, L3, then DRAM."""
    out = []
    for kb in [s for s in [32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144] if s <= max_kb]:
        _chk(cancel)
        m = kb * 1024 // 12
        a, b, c = np.ones(m, np.float32), np.ones(m, np.float32), np.empty(m, np.float32)
        np.add(a, b, out=c)
        t = time.perf_counter()
        np.add(a, b, out=c)
        one = max(time.perf_counter() - t, 1e-7)
        reps = max(2, int(0.04 / one))
        xs = []
        for _ in range(1 + min_samples):
            t = time.perf_counter()
            for _ in range(reps):
                _chk(cancel)
                np.add(a, b, out=c)
            xs.append(12 * m * reps / (time.perf_counter() - t) / 1e9)
        st = _stats(xs, 1)
        out.append({"kb": kb, "gbps": st["median"], "best": round(max(xs), 1), "ci95": st["ci95"], "n": st["n"],
                    "work_gb": round(12 * m * reps * len(xs) / 1e9, 3)})
        if cb:
            cb(st["median"], max(o["gbps"] for o in out), kb)
    return out


# ---- storage: a private temp file, unbuffered I/O, always deleted
_TMP_NAME = "neural-studio-bench"
CHUNK = 4 * 2**20


def temp_dir() -> str:
    """The private directory for benchmark files. Refused when it is a symlink/junction or owned by someone else."""
    import stat
    d = os.path.join(tempfile.gettempdir(), _TMP_NAME)
    if os.path.lexists(d):
        st = os.lstat(d)
        if stat.S_ISLNK(st.st_mode) or (getattr(st, "st_file_attributes", 0) & 0x400) or not stat.S_ISDIR(st.st_mode):
            raise RuntimeError("The benchmark temp directory is a link. Refusing to write there.")
        if hasattr(os, "getuid") and st.st_uid != os.getuid():
            raise RuntimeError("The benchmark temp directory belongs to another user. Refusing to write there.")
    else:
        os.mkdir(d, 0o700)
    return d


def sweep_temp() -> int:
    """Delete leftovers of an earlier crashed run. Never follows links."""
    try:
        d = temp_dir()
    except Exception:  # noqa: BLE001
        return 0
    n = 0
    for name in os.listdir(d):
        p = os.path.join(d, name)
        try:
            if os.path.isdir(p) and not os.path.islink(p):
                continue
            os.unlink(p)
            n += 1
        except OSError:
            pass
    return n


def _disk_read(path: str, limit: int = 768 * 2**20, cb=None, cancel=None) -> dict | None:
    """Sequential read straight from the device (no OS cache on Windows). Per-chunk rates are the samples."""
    if not path or not os.path.exists(path):
        return None
    size = min(os.path.getsize(path), limit)
    chunk = CHUNK
    rates: list[float] = []
    if not IS_WIN:
        done = 0
        with open(path, "rb", buffering=0) as f:
            while done < size:
                _chk(cancel)
                t = time.perf_counter()
                got = len(f.read(chunk))
                if not got:
                    break
                done += got
                rates.append(got / max(1e-9, time.perf_counter() - t) / 1e9)
                if cb:
                    cb(rates[-1], max(rates))
        return _disk_out(rates, done, True, path)
    from ctypes import wintypes
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateFileW.restype = wintypes.HANDLE
    k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    k32.VirtualAlloc.restype = ctypes.c_void_p
    k32.VirtualAlloc.argtypes = [ctypes.c_void_p, ctypes.c_size_t, wintypes.DWORD, wintypes.DWORD]
    k32.ReadFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    k32.VirtualFree.argtypes = [ctypes.c_void_p, ctypes.c_size_t, wintypes.DWORD]
    h = k32.CreateFileW(path, 0x80000000, 1, None, 3, 0x20000000 | 0x08000000, None)  # NO_BUFFERING | SEQUENTIAL_SCAN
    if h in (None, ctypes.c_void_p(-1).value):
        return None
    buf = k32.VirtualAlloc(None, chunk, 0x3000, 4)
    got, total = wintypes.DWORD(0), 0
    try:
        while total < size:
            _chk(cancel)
            t = time.perf_counter()
            if not k32.ReadFile(h, buf, chunk, ctypes.byref(got), None) or got.value == 0:
                break
            total += got.value
            rates.append(got.value / max(1e-9, time.perf_counter() - t) / 1e9)
            if cb:
                cb(rates[-1], max(rates))
    finally:
        k32.CloseHandle(h)
        k32.VirtualFree(buf, 0, 0x8000)
    return _disk_out(rates, total, False, path)


def _disk_out(rates: list[float], total: int, cached: bool, path: str) -> dict | None:
    if not rates:
        return None
    st = _stats(rates, 1)
    return {"gbps": st["median"], "ci95": st["ci95"], "peak_gbps": round(max(rates), 2), "mb": round(total / 1e6), "cached": cached,
            "spread": st, "file": os.path.basename(path)}


def _disk_bench(mb: int = 256, cb=None, cancel=None) -> dict | None:
    """Write then read a private temp file. The file is deleted in every outcome (done, error, cancel)."""
    d = temp_dir()
    path = os.path.join(d, f"bench-{os.getpid()}-{int(time.time() * 1000)}.bin")
    size = mb * 2**20
    block = os.urandom(CHUNK)
    wr: list[float] = []
    fd = None
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o600)
        with os.fdopen(fd, "wb", buffering=0) as f:
            fd = None
            done = 0
            while done < size:
                _chk(cancel)
                t = time.perf_counter()
                f.write(block)
                os.fsync(f.fileno())
                wr.append(CHUNK / max(1e-9, time.perf_counter() - t) / 1e9)
                done += CHUNK
                if cb:
                    cb(wr[-1], max(wr))
        rd = _disk_read(path, size, cb, cancel)
        if rd is None:
            return None
        w = _stats(wr, 1)
        rd.update(write_gbps=w["median"], write_ci95=w["ci95"], write_spread=w,
                  work={"amount": round(2 * size / 1e9, 3), "unit": "GB"})
        return rd
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass


def _network(cb=None, seconds: float = 3.0, cancel=None) -> dict | None:
    """Download from a fixed host in 0.2 s windows (the samples). Connect and read time out after 5 s each."""
    url = "https://huggingface.co/openai-community/gpt2/resolve/main/model.safetensors"
    cap = 64 * 2**20
    try:
        t0 = time.perf_counter()
        r = requests.get(url, headers={"Range": f"bytes=0-{cap - 1}", "User-Agent": "kundali/0.1"}, stream=True, timeout=(5, 5))
        ttfb = time.perf_counter() - t0
        got, w_got = 0, 0
        t1 = w_t = time.perf_counter()
        wins: list[float] = []
        try:
            for chunk in r.iter_content(131072):
                _chk(cancel)
                got += len(chunk)
                w_got += len(chunk)
                now = time.perf_counter()
                if now - w_t >= 0.2:
                    wins.append(w_got / (now - w_t) / 1e6 * 8)
                    w_got, w_t = 0, now
                    if cb:
                        cb(wins[-1], max(wins))
                if now - t1 >= seconds or got >= cap:
                    break
        finally:
            r.close()
        if len(wins) < 3:
            wins.append(got / max(1e-3, time.perf_counter() - t1) / 1e6 * 8)
        st = _stats(wins, 1)
        dt = max(1e-3, time.perf_counter() - t1)
        return {"mbps": round(st["median"]), "ci95": st["ci95"], "mbytes_s": round(got / dt / 1e6, 1), "latency_ms": round(ttfb * 1000), "mb": round(got / 1e6),
                "spread": st, "work": {"amount": round(got / 1e6, 1), "unit": "MB"}}
    except Cancelled:
        raise
    except Exception:  # noqa: BLE001
        return None


def bench_run(emit, client=None, plan=None, cancel=None):
    """Run the microbenchmarks (all of them by default). See bench.py for the plan and the orchestration."""
    from . import bench
    bench.run(emit, client, plan or bench.default_plan(client is not None), cancel)


def bench_steps():
    """Non-streaming wrapper: yield (name, result) once each test is done."""
    out = []
    bench_run(lambda m: out.append(m) if m["type"] == "result" else None)
    for m in out:
        yield m["name"], m["data"]


# ----------------------------------------------------------------------------- instrumented runs
class OpTimer:
    """Time every projection, norm and the attention/MLP wrappers in one forward pass."""

    def __init__(self, arch, T: int, S: int):
        self.a, self.T, self.S = arch, T, S
        self.ev: list[dict] = []
        self.handles = []
        self.t0 = 0

    def _wrap(self, mod, name, layer, kind, flops, wbytes, abytes):
        st = {}

        def pre(_m, _a):
            st["s"] = time.perf_counter_ns()

        def post(_m, _a, _o):
            e = time.perf_counter_ns()
            self.ev.append({"layer": layer, "name": name, "kind": kind, "s": st["s"], "e": e, "flops": flops, "wbytes": wbytes, "abytes": abytes})

        self.handles += [mod.register_forward_pre_hook(pre), mod.register_forward_hook(post)]

    def install(self):
        a, T, S = self.a, self.T, self.S
        H, nh, nkv, hd = a.H, a.nh, a.nkv, a.hd
        qd, kd = nh * hd, nkv * hd
        m = a.model
        I = a.down(0).weight.shape[1 if not a.gpt2 else 0]
        V = m.lm_head.weight.shape[0]
        f4 = 4

        def lin(i_, o_, bias=False):
            return 2 * T * i_ * o_, (i_ * o_ + (o_ if bias else 0)) * f4, (T * i_ + T * o_) * f4

        def norm():
            return 5 * T * H, H * f4, 2 * T * H * f4

        if a.gpt2:
            self._wrap(m.transformer.wte, "embed", -1, "embed", 0, T * H * f4, T * H * f4)
            self._wrap(m.transformer.ln_f, "final_norm", a.L, "norm", *norm())
        else:
            self._wrap(m.model.embed_tokens, "embed", -1, "embed", 0, T * H * f4, T * H * f4)
            self._wrap(m.model.norm, "final_norm", a.L, "norm", *norm())
        self._wrap(m.lm_head, "lm_head", a.L, "matmul", *lin(H, V))
        for i in range(a.L):
            L = a.layers[i]
            at, ml = a.attn(i), a.mlp(i)
            if a.gpt2:
                self._wrap(L.ln_1, "norm1", i, "norm", *norm())
                self._wrap(at.c_attn, "qkv_proj", i, "matmul", *lin(H, 3 * H, True))
                self._wrap(at.c_proj, "o_proj", i, "matmul", *lin(H, H, True))
                self._wrap(L.ln_2, "norm2", i, "norm", *norm())
                self._wrap(ml.c_fc, "up_proj", i, "matmul", *lin(H, I, True))
                self._wrap(ml.c_proj, "down_proj", i, "matmul", *lin(I, H, True))
            else:
                bias = bool(getattr(at.q_proj, "bias", None) is not None)
                self._wrap(L.input_layernorm, "norm1", i, "norm", *norm())
                self._wrap(at.q_proj, "q_proj", i, "matmul", *lin(H, qd, bias))
                self._wrap(at.k_proj, "k_proj", i, "matmul", *lin(H, kd, bias))
                self._wrap(at.v_proj, "v_proj", i, "matmul", *lin(H, kd, bias))
                self._wrap(at.o_proj, "o_proj", i, "matmul", *lin(qd, H))
                self._wrap(L.post_attention_layernorm, "norm2", i, "norm", *norm())
                self._wrap(ml.gate_proj, "gate_proj", i, "matmul", *lin(H, I))
                self._wrap(ml.up_proj, "up_proj", i, "matmul", *lin(H, I))
                self._wrap(ml.down_proj, "down_proj", i, "matmul", *lin(I, H))
            self._wrap(at, "_attn_total", i, "_wrapper", 0, 0, 0)
            self._wrap(ml, "_mlp_total", i, "_wrapper", 0, 0, 0)

    def remove(self):
        for h in self.handles:
            h.remove()
        self.handles = []

    def result(self, t0_ns: int) -> list[dict]:
        """Add the derived ops (attention core, MLP activation) and convert to milliseconds from t0."""
        a, T, S = self.a, self.T, self.S
        by = {}
        for e in self.ev:
            by[(e["layer"], e["name"])] = e
        out = [e for e in self.ev if e["kind"] != "_wrapper"]
        proj_names = ("q_proj", "k_proj", "v_proj", "o_proj", "qkv_proj")
        for i in range(a.L):
            at = by.get((i, "_attn_total"))
            if at:
                inside = [by[(i, n)] for n in proj_names if (i, n) in by]
                core_ms = (at["e"] - at["s"]) - sum(x["e"] - x["s"] for x in inside)
                end_qkv = max([by[(i, n)]["e"] for n in ("q_proj", "k_proj", "v_proj", "qkv_proj") if (i, n) in by] or [at["s"]])
                nh, hd, kd = a.nh, a.hd, a.nkv * a.hd
                out.append({"layer": i, "name": "attn_core", "kind": "attention", "s": end_qkv, "e": end_qkv + max(0, int(core_ms)),
                            "flops": 4 * nh * T * S * hd + 5 * nh * T * S, "wbytes": 0, "abytes": (2 * T * nh * hd + 2 * S * kd) * 4,
                            "note": "RoPE, scores = q·k, softmax, weighted sum of v (derived: attention wrapper minus its projections)"})
            mt = by.get((i, "_mlp_total"))
            if mt:
                inner = [by[(i, n)] for n in ("gate_proj", "up_proj", "down_proj") if (i, n) in by]
                act_ms = (mt["e"] - mt["s"]) - sum(x["e"] - x["s"] for x in inner)
                I = a.down(i).weight.shape[1 if not a.gpt2 else 0]
                start = max([x["e"] for x in inner if x["name"] != "down_proj"] or [mt["s"]])
                out.append({"layer": i, "name": "mlp_act", "kind": "activation", "s": start, "e": start + max(0, int(act_ms)),
                            "flops": 5 * T * I, "wbytes": 0, "abytes": 3 * T * I * 4,
                            "note": "SiLU/GELU and the gate x up product (derived: MLP wrapper minus its projections)"})
        out.sort(key=lambda e: (e["s"], e["layer"]))
        return [{**{k: v for k, v in e.items() if k not in ("s", "e")}, "start_ms": round((e["s"] - t0_ns) / 1e6, 4), "ms": round((e["e"] - e["s"]) / 1e6, 4)} for e in out]


def _summarise(ops: list[dict], peak_gflops: float, peak_gbps: float) -> dict:
    ridge = peak_gflops / peak_gbps if peak_gbps else None
    for o in ops:
        sec = max(o["ms"], 1e-6) / 1e3
        byt = o["wbytes"] + o["abytes"]
        o["gflops"] = round(o["flops"] / sec / 1e9, 2)
        o["gbps"] = round(byt / sec / 1e9, 2)
        o["ai"] = round(o["flops"] / byt, 3) if byt else None
        o["bound"] = None if o["ai"] is None or not ridge else ("memory" if o["ai"] < ridge else "compute")
    tot_ms = max(o["start_ms"] + o["ms"] for o in ops) if ops else 0
    return {"total_ms": round(tot_ms, 3), "flops": sum(o["flops"] for o in ops), "wbytes": sum(o["wbytes"] for o in ops),
            "abytes": sum(o["abytes"] for o in ops), "ridge": round(ridge, 2) if ridge else None}


def journey(h, prompt: str, new_tokens: int = 16, peaks: dict | None = None) -> dict:
    """Instrument one real generation: tokenize, embed, every layer's ops, logits, sampling, decode loop."""
    from . import runner
    a, tok, model = h.arch, h.tok, h.model
    peaks = peaks or {}
    pg, pb = float(peaks.get("gflops") or 0), float(peaks.get("gbps") or 0)
    with h.lock:
        # tokenizer
        reps = 200
        t = time.perf_counter()
        for _ in range(reps):
            enc = tok(prompt, return_tensors="pt")
        tok_us = (time.perf_counter() - t) / reps * 1e6
        ids = enc["input_ids"]
        T = ids.shape[1]
        if T > runner.MAX_TOKENS:
            raise ValueError(f"Prompt has {T} tokens; the limit is {runner.MAX_TOKENS}.")
        tokens = [tok.decode([i]) for i in ids[0].tolist()]
        with torch.no_grad():
            model(**enc, use_cache=True)  # warm-up: touch weight pages, spin up the thread pool

            # prefill, timed op by op
            timer = OpTimer(a, T, T)
            timer.install()
            t0 = time.perf_counter_ns()
            out = model(**enc, use_cache=True)
            t_end = time.perf_counter_ns()
            timer.remove()
            prefill = timer.result(t0)
            pkv = out.past_key_values
            logits = out.logits[0, -1].float()

            # sampling stage
            t = time.perf_counter_ns()
            probs = torch.softmax(logits, dim=-1)
            top = probs.topk(5)
            chosen = int(top.indices[0])
            samp_us = (time.perf_counter_ns() - t) / 1e3

            # decode: one token at a time with the KV cache
            nxt = torch.tensor([[chosen]])
            dec_steps, dec_tokens, dec_ms = [], [], []
            gen_text = tok.decode([chosen])
            dec_tokens.append({"text": tok.decode([chosen]), "ms": None})
            for k in range(max(2, new_tokens)):
                S = T + k + 1
                timer = OpTimer(a, 1, S)
                timer.install()
                t0 = time.perf_counter_ns()
                o = model(input_ids=nxt, past_key_values=pkv, use_cache=True)
                te = time.perf_counter_ns()
                timer.remove()
                pkv = o.past_key_values
                if k < 3 or k == new_tokens - 1:
                    dec_steps.append(timer.result(t0))
                nid = int(o.logits[0, -1].argmax())
                dec_ms.append((te - t0) / 1e6)
                dec_tokens.append({"text": tok.decode([nid]), "ms": round((te - t0) / 1e6, 2)})
                nxt = torch.tensor([[nid]])
            detok_t = time.perf_counter()
            full = tok.decode([int(i) for i in ids[0].tolist()] + [chosen])
            detok_us = (time.perf_counter() - detok_t) * 1e6

    # median decode timings per op across measured steps (skip the first, which is warm-up)
    use = dec_steps[1:] or dec_steps
    med: dict = {}
    for steps in use:
        for o in steps:
            med.setdefault((o["layer"], o["name"]), []).append(o["ms"])
    decode_ops = []
    for o in dec_steps[-1]:
        decode_ops.append({**o, "ms": round(statistics.median(med[(o["layer"], o["name"])]), 4)})
    dsum = _summarise(decode_ops, pg, pb)
    psum = _summarise(prefill, pg, pb)
    step_ms = statistics.median(dec_ms[1:] or dec_ms)
    wbytes = dsum["wbytes"]
    return {
        "repo": h.repo, "prompt": prompt, "L": a.L, "dims": {"H": a.H, "nh": a.nh, "nkv": a.nkv, "hd": a.hd, "V": model.lm_head.weight.shape[0]},
        "input": {"text": prompt, "chars": len(prompt), "utf8_bytes": len(prompt.encode("utf-8"))},
        "tokenize": {"tokens": tokens, "ids": ids[0].tolist(), "us": round(tok_us, 1), "vocab": len(tok)},
        "prefill": {"ops": prefill, **psum, "wall_ms": round((t_end - t0) / 1e6 if False else psum["total_ms"], 3), "T": T},
        "sample": {"top": [{"token": tok.decode([int(i)]), "p": round(float(p), 4)} for p, i in zip(top.values, top.indices)],
                   "chosen": tok.decode([chosen]), "us": round(samp_us, 1)},
        "decode": {"ops": decode_ops, **dsum, "tokens": dec_tokens, "step_ms": round(step_ms, 3), "tps": round(1000 / step_ms, 1),
                   "effective_gbps": round(wbytes / (step_ms / 1e3) / 1e9, 2), "weight_bytes": wbytes},
        "detok": {"text": full, "us": round(detok_us, 1)},
        "threads": torch.get_num_threads(),
    }


def microscope(h, prompt: str, layer: int = 0, row: int = 0) -> dict:
    """One real dot product from the first projection of a block, chunked 16 floats at a time (one AVX-512 register)."""
    a = h.arch
    enc = h.tok(prompt, return_tensors="pt")
    mod = a.attn(layer).c_attn if a.gpt2 else a.attn(layer).q_proj
    cap = {}
    hk = mod.register_forward_hook(lambda _m, i, o: cap.update(x=i[0][0, -1].detach().clone(), y=o[0, -1].detach().clone()))
    try:
        with h.lock, torch.no_grad():
            h.model(**enc)
    finally:
        hk.remove()
    x, y = cap["x"].float(), cap["y"].float()
    w = (mod.weight[:, row] if a.gpt2 else mod.weight[row]).detach().float()
    bias = float(mod.bias[row]) if getattr(mod, "bias", None) is not None else 0.0
    prod = x * w
    lanes = 16
    chunks = [float(prod[i:i + lanes].sum()) for i in range(0, len(prod), lanes)]
    run, partial = 0.0, []
    for c in chunks:
        run += c
        partial.append(run)
    full = float(prod.sum()) + bias
    return {
        "layer": layer, "row": row, "op": "qkv_proj" if a.gpt2 else "q_proj", "length": len(x), "lanes": lanes,
        "x": [round(float(v), 4) for v in x[:lanes]], "w": [round(float(v), 4) for v in w[:lanes]],
        "products": [round(float(v), 4) for v in prod[:lanes]], "chunk_sums": [round(v, 4) for v in chunks], "running": [round(v, 4) for v in partial],
        "bias": round(bias, 4), "dot": round(full, 5), "module_output": round(float(y[row]), 5), "match_err": float(abs(full - float(y[row]))),
        "fma_instructions": math.ceil(len(x) / lanes),
    }
