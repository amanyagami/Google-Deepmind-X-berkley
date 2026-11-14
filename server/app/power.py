"""Live electrical and clock sensors read from Windows performance counters (PDH), no admin needed.

- Energy Meter (RAPL): CPU package power and per-core power, measured by the CPU itself.
- Processor Information: effective clock (base MHz x % processor performance).
- Thermal Zone Information: ACPI thermal zone temperature (a board sensor, not the CPU die).

Every value returned is a sensor reading. If a counter is missing the field is None.
"""
from __future__ import annotations

import ctypes
import platform
import threading
from ctypes import wintypes

IS_WIN = platform.system() == "Windows"


class _Val(ctypes.Structure):
    _fields_ = [("CStatus", wintypes.DWORD), ("pad", wintypes.DWORD), ("doubleValue", ctypes.c_double)]


class Pdh:
    def __init__(self):
        self.ok = False
        self.lock = threading.Lock()
        self.counters: dict[str, ctypes.c_void_p] = {}
        if not IS_WIN:
            return
        try:
            self.dll = ctypes.WinDLL("pdh")
            self.q = ctypes.c_void_p()
            if self.dll.PdhOpenQueryW(None, None, ctypes.byref(self.q)) != 0:
                return
            self.ok = True
        except OSError:
            return

    def add(self, key: str, path: str) -> bool:
        if not self.ok:
            return False
        h = ctypes.c_void_p()
        if self.dll.PdhAddEnglishCounterW(self.q, ctypes.c_wchar_p(path), None, ctypes.byref(h)) == 0:
            self.counters[key] = h
            return True
        return False

    def collect(self) -> dict[str, float | None]:
        out: dict[str, float | None] = {}
        if not self.ok:
            return out
        with self.lock:
            self.dll.PdhCollectQueryData(self.q)
            for k, h in self.counters.items():
                v = _Val()
                r = self.dll.PdhGetFormattedCounterValue(h, 0x00000200 | 0x00008000, None, ctypes.byref(v))  # DOUBLE | NOCAP100
                out[k] = v.doubleValue if r == 0 and v.CStatus in (0, 1) else None
        return out


_P: Pdh | None = None
_N_CORES = 0


def _init(n_cores: int) -> Pdh:
    global _P, _N_CORES
    if _P is None:
        p = Pdh()
        p.add("pkg_mw", r"\Energy Meter(RAPL_Package0_PKG)\Power")
        for i in range(n_cores):
            if not p.add(f"core{i}_mw", rf"\Energy Meter(RAPL_Package0_Core{i}_CORE)\Power"):
                break
            _N_CORES = i + 1
        p.add("freq_mhz", r"\Processor Information(_Total)\Processor Frequency")
        p.add("perf_pct", r"\Processor Information(_Total)\% Processor Performance")
        p.add("thermal_k", r"\Thermal Zone Information(*)\Temperature")
        p.add("throttle", r"\Thermal Zone Information(*)\Throttle Reasons")
        p.add("passive_pct", r"\Thermal Zone Information(*)\% Passive Limit")
        p.collect()  # rate counters need a first sample
        _P = p
    return _P


INTERVAL = 0.1  # one collector at a steady 10 Hz: RAPL is an energy counter, and power = energy delta / interval,
                 # so several readers collecting at random moments would produce tiny, noisy intervals.
_latest: dict = {}
_cv = threading.Condition()
_thread: threading.Thread | None = None


def _loop(n_cores: int):
    import time
    seq = 0
    while True:
        t0 = time.perf_counter()
        s = _read(n_cores)
        seq += 1
        with _cv:
            _latest.clear()
            _latest.update(s, seq=seq, t=time.time())
            _cv.notify_all()
        time.sleep(max(0.0, INTERVAL - (time.perf_counter() - t0)))


def sample(n_cores: int) -> dict:
    """The latest reading (power in watts, clock in MHz, temperature in deg C). Starts the collector on first use."""
    global _thread
    if not IS_WIN:
        return {"source": None}
    if _thread is None:
        _init(n_cores)
        _thread = threading.Thread(target=_loop, args=(n_cores,), daemon=True)
        _thread.start()
    with _cv:
        if not _latest:
            _cv.wait(timeout=1.0)
        return dict(_latest)


def wait_next(after_seq: int, timeout: float = 1.0) -> dict:
    """Block until a reading newer than `after_seq` exists (for recorders that want every sample once)."""
    with _cv:
        _cv.wait_for(lambda: _latest.get("seq", 0) > after_seq, timeout=timeout)
        return dict(_latest)


def _read(n_cores: int) -> dict:
    p = _init(n_cores)
    v = p.collect()
    if not v:
        return {"source": None}
    cores = [v.get(f"core{i}_mw") for i in range(_N_CORES)]
    w = lambda x: None if x is None else round(x / 1000, 2)  # noqa: E731 - RAPL counters are milliwatts
    eff = None
    if v.get("freq_mhz") and v.get("perf_pct"):
        eff = round(v["freq_mhz"] * v["perf_pct"] / 100)
    tk = v.get("thermal_k")
    return {
        "source": "Windows Energy Meter (RAPL) + Processor Information + ACPI thermal zone",
        "pkg_w": w(v.get("pkg_mw")),
        "core_w": [w(c) for c in cores],
        "eff_mhz": eff, "base_mhz": round(v["freq_mhz"]) if v.get("freq_mhz") else None,
        "perf_pct": round(v["perf_pct"], 1) if v.get("perf_pct") else None,
        "temp_c": round(tk - 273.15, 1) if tk else None,
        "throttle": int(v["throttle"]) if v.get("throttle") is not None else None,
        "passive_pct": v.get("passive_pct"),
    }


if __name__ == "__main__":
    import time
    for _ in range(5):
        time.sleep(0.5)
        print(sample(8))
