"""Live electrical and clock sensors read from Windows performance counters (PDH), no admin needed.

- Energy Meter (RAPL): CPU package and per-core energy, measured by the CPU itself. Watts are energy deltas over one
  shared interval (every counter is read by the same collect), and the cores are reconciled so their sum never
  exceeds the package (decision D19).
- Processor Information: effective clock (base MHz x % processor performance).
- Thermal Zone Information: ACPI thermal zone temperature (a board sensor, not the CPU die).

Every value returned is a sensor reading. If a counter is missing the field is None.
"""
from __future__ import annotations

import ctypes
import platform
import threading
import time
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
        # Cumulative energy counters (picowatt-hours) and the meter's own clock (ms). The ready-made "Power" counters are
        # kept only as a fallback: read one by one they can describe different windows, and cores came out above the package.
        p.add("pkg_e", r"\Energy Meter(RAPL_Package0_PKG)\Energy")
        p.add("pkg_t", r"\Energy Meter(RAPL_Package0_PKG)\Time")
        p.add("pkg_mw", r"\Energy Meter(RAPL_Package0_PKG)\Power")
        for i in range(n_cores):
            if not p.add(f"core{i}_mw", rf"\Energy Meter(RAPL_Package0_Core{i}_CORE)\Power"):
                break
            p.add(f"core{i}_e", rf"\Energy Meter(RAPL_Package0_Core{i}_CORE)\Energy")
            _N_CORES = i + 1
        p.add("freq_mhz", r"\Processor Information(_Total)\Processor Frequency")
        p.add("perf_pct", r"\Processor Information(_Total)\% Processor Performance")
        p.add("thermal_k", r"\Thermal Zone Information(*)\Temperature")
        p.add("throttle", r"\Thermal Zone Information(*)\Throttle Reasons")
        p.add("passive_pct", r"\Thermal Zone Information(*)\% Passive Limit")
        p.collect()  # rate counters need a first sample
        _P = p
    return _P


PWH_TO_J = 3600e-12  # the Energy counters count picowatt-hours


def watts_from_energy(prev: dict | None, cur: dict, n_cores: int) -> dict | None:
    """Package and per-core watts from two readings of the cumulative energy counters, each taken in one collect.

    `prev` / `cur` hold pkg_e and core{i}_e (picowatt-hours), pkg_t (the meter's clock, ms) and wall (seconds, the
    fallback clock). Every counter is divided by the SAME interval, so cores and package describe the same window.
    Returns None when the package counter is missing, went backwards (reset) or the interval is too short to trust.
    """
    if not prev or prev.get("pkg_e") is None or cur.get("pkg_e") is None:
        return None
    dt = None
    if cur.get("pkg_t") is not None and prev.get("pkg_t") is not None and cur["pkg_t"] > prev["pkg_t"]:
        dt = (cur["pkg_t"] - prev["pkg_t"]) / 1000.0
    elif cur.get("wall") is not None and prev.get("wall") is not None:
        dt = cur["wall"] - prev["wall"]
    if not dt or dt < 0.02:
        return None
    de = cur["pkg_e"] - prev["pkg_e"]
    if de < 0:
        return None
    cores: list[float | None] = []
    for i in range(n_cores):
        a, b = prev.get(f"core{i}_e"), cur.get(f"core{i}_e")
        cores.append(None if a is None or b is None or b < a else (b - a) * PWH_TO_J / dt)
    return {"pkg_w": de * PWH_TO_J / dt, "core_w": cores, "dt": dt}


def reconcile(pkg_w: float | None, core_w: list) -> tuple[list, str | None, float | None]:
    """Cores can never draw more than the package they sit in (D19).

    If the cores add up to more than the package (on Zen mobile the per-core RAPL counters are not a strict subset of
    the package counter), they are scaled by package / sum and flagged "core-scaled" with the raw ratio, so the page can
    say the split is approximate instead of silently clamping "rest of chip" to zero.
    Returns (cores, flag or None, raw core sum / package).
    """
    if pkg_w is None or not core_w:
        return core_w, None, None
    vals = [None if c is None else max(0.0, c) for c in core_w]
    total = sum(c for c in vals if c is not None)
    if pkg_w <= 0:
        return ([None if c is None else 0.0 for c in vals], "core-scaled", None) if total > 0 else (vals, None, None)
    ratio = total / pkg_w
    if total <= pkg_w:
        return vals, None, ratio
    k = pkg_w / total
    return [None if c is None else c * k for c in vals], "core-scaled", ratio


INTERVAL = 0.1  # one collector at a steady 10 Hz: RAPL is an energy counter, and power = energy delta / interval,
                 # so several readers collecting at random moments would produce tiny, noisy intervals.
_latest: dict = {}
_cv = threading.Condition()
_thread: threading.Thread | None = None


def _loop(n_cores: int):
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


_last_e: dict | None = None


def build_reading(v: dict, prev_e: dict | None, n_cores: int, wall: float) -> tuple[dict, dict]:
    """One reading from one collect `v`. Returns (reading, energy snapshot to pass as `prev_e` next time)."""
    snap = {k: x for k, x in v.items() if k.endswith("_e") or k == "pkg_t"}
    snap["wall"] = wall
    got = watts_from_energy(prev_e, snap, n_cores)
    if got is not None:
        pkg, cores, how = got["pkg_w"], got["core_w"], "energy"
    else:  # no energy counters, or the very first reading: the ready-made power counters (milliwatts)
        mw = lambda x: None if x is None else x / 1000  # noqa: E731
        pkg, cores, how = mw(v.get("pkg_mw")), [mw(v.get(f"core{i}_mw")) for i in range(n_cores)], "power"
    cores, split, ratio = reconcile(pkg, cores)
    r2 = lambda x: None if x is None else round(x, 2)  # noqa: E731
    eff = round(v["freq_mhz"] * v["perf_pct"] / 100) if v.get("freq_mhz") and v.get("perf_pct") else None
    tk = v.get("thermal_k")
    return {
        "source": "Windows Energy Meter (RAPL) + Processor Information + ACPI thermal zone",
        "pkg_w": r2(pkg),
        "core_w": [r2(c) for c in cores],
        "from": how,                                         # "energy": counter deltas; "power": ready-made counters
        "split": split,                                      # "core-scaled" when the cores had to be scaled to the package
        "core_ratio": None if ratio is None else round(ratio, 3),
        "eff_mhz": eff, "base_mhz": round(v["freq_mhz"]) if v.get("freq_mhz") else None,
        "perf_pct": round(v["perf_pct"], 1) if v.get("perf_pct") else None,
        "temp_c": round(tk - 273.15, 1) if tk else None,
        "throttle": int(v["throttle"]) if v.get("throttle") is not None else None,
        "passive_pct": v.get("passive_pct"),
    }, snap


def _read(n_cores: int) -> dict:
    global _last_e
    p = _init(n_cores)
    v = p.collect()
    if not v:
        return {"source": None}
    out, _last_e = build_reading(v, _last_e, _N_CORES, time.perf_counter())
    return out


if __name__ == "__main__":
    for _ in range(5):
        time.sleep(0.5)
        print(sample(8))
