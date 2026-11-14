"""Per-component benchmark plans: validation, orchestration, cancel, per-component energy.

Wire (WebSocket /ws/bench), first message:
  {"type":"start","only":["matmul_1",...],"params":{...},"baseline":false}   (no first message = full run)
  {"type":"cancel"}                                                            (any time)
  {"type":"client_result","id":<task id>,"name":"gpu","data":{...}}            (answer to a client_task)
"""
from __future__ import annotations

import math
import shutil
import threading
import time
from dataclasses import dataclass, field

import psutil

COMPONENTS = ("matmul_1", "matmul_n", "cache", "dram", "disk", "net", "gpu", "ai")
WORKLOAD_V = 1          # bump when a workload changes so old results are not compared with new ones
MIN_WINDOW_S = 2.0      # energy is only reported over windows at least this long


class BadRequest(ValueError):
    pass


@dataclass
class Plan:
    only: list[str]
    params: dict = field(default_factory=dict)
    baseline: bool = False
    draw: bool = False


def _avail_ram() -> int:
    return psutil.virtual_memory().available


def _free_disk() -> int:
    from . import hw
    return shutil.disk_usage(hw.temp_dir()).free


def caps() -> dict[str, tuple[float, float, bool]]:
    """{param: (min, max, is_int)} for this machine right now."""
    ram, disk = _avail_ram(), _free_disk()
    nmax = int(math.sqrt(0.25 * ram / 12))            # three n x n float32 matrices <= 25% of free RAM
    cores = psutil.cpu_count(logical=True) or 1
    return {
        "seconds": (0.5, 30.0, False),
        "samples": (5, 100, True),
        "n": (128, max(128, min(4096, nmax)), True),
        "threads": (1, cores, True),
        "ram_mb": (16, max(16, min(2048, int(0.5 * ram / 2**20))), True),
        "max_kb": (32, max(32, min(262144, int(0.25 * ram / 1024))), True),
        "disk_mb": (32, max(32, min(4096, int(0.2 * disk / 2**20))), True),
        "tokens": (12, 128, True),
    }


def default_plan(with_client: bool = True) -> Plan:
    return Plan(only=[c for c in COMPONENTS if c != "gpu" or with_client], params={}, baseline=True, draw=with_client)


def validate_start(msg: dict) -> Plan:
    """Check a {'type':'start'} message against the fixed enum and the caps. Raises BadRequest."""
    if not isinstance(msg, dict):
        raise BadRequest("Message must be an object.")
    only = msg.get("only")
    if only is None:
        only = list(COMPONENTS)
    if not isinstance(only, list) or not only or len(only) > len(COMPONENTS):
        raise BadRequest("'only' must be a non-empty list of component ids.")
    for x in only:
        if not isinstance(x, str) or x not in COMPONENTS:
            raise BadRequest(f"Unknown component {str(x)[:40]!r}. Allowed: {', '.join(COMPONENTS)}.")
    ordered = [c for c in COMPONENTS if c in only]
    params = msg.get("params", {})
    if params is None:
        params = {}
    if not isinstance(params, dict):
        raise BadRequest("'params' must be an object.")
    c = caps()
    out: dict = {}
    for k, v in params.items():
        if k not in c:
            raise BadRequest(f"Parameter {str(k)[:40]!r} is not accepted.")
        lo, hi, is_int = c[k]
        if isinstance(v, bool) or not isinstance(v, (int, float)) or (isinstance(v, float) and not math.isfinite(v)):
            raise BadRequest(f"Parameter {k} must be a number.")
        if is_int and float(v) != int(v):
            raise BadRequest(f"Parameter {k} must be a whole number.")
        if not lo <= v <= hi:
            raise BadRequest(f"Parameter {k} must be between {lo:g} and {hi:g} on this machine.")
        out[k] = int(v) if is_int else float(v)
    bl = msg.get("baseline", False)
    if not isinstance(bl, bool):
        raise BadRequest("'baseline' must be true or false.")
    return Plan(only=ordered, params=out, baseline=bl)


class ClientTasks:
    """Round trips to the browser (the WebGPU test). One Event per task id, no shared state between tasks."""

    def __init__(self, emit):
        self.emit = emit
        self._lock = threading.Lock()
        self._tasks: dict[str, dict] = {}
        self._n = 0

    def request(self, name: str, cancel: threading.Event | None = None, timeout: float = 90.0):
        with self._lock:
            self._n += 1
            tid = f"t{self._n}"
            t = {"ev": threading.Event(), "data": None, "name": name}
            self._tasks[tid] = t
        self.emit({"type": "client_task", "name": name, "id": tid})
        end = time.monotonic() + timeout
        try:
            while not t["ev"].wait(0.05):
                if (cancel is not None and cancel.is_set()) or time.monotonic() > end:
                    break
            return t["data"]
        finally:
            with self._lock:
                self._tasks.pop(tid, None)

    def deliver(self, msg: dict) -> None:
        with self._lock:
            tid = msg.get("id")
            t = self._tasks.get(tid) if tid is not None else next((x for x in self._tasks.values() if x["name"] == msg.get("name")), None)
        if t:
            t["data"] = msg.get("data")
            t["ev"].set()

    def cancel_all(self) -> None:
        with self._lock:
            for t in self._tasks.values():
                t["ev"].set()


def run(emit, client, plan: Plan, cancel: threading.Event | None = None) -> None:
    """Run the plan. `emit(dict)` gets stage/progress/result/power messages; `client(name, cancel)` runs a browser-only test.
    Raises hw.Cancelled when cancelled (after the recorder stopped and temp files were removed)."""
    from . import hw
    cancel = cancel or threading.Event()
    P = plan.params
    sec = P.get("seconds", 2.0)
    smp = P.get("samples", 5)
    works: dict[str, dict] = {}

    def prog(name, unit, scale=1.0):
        def cb(v, best, *extra):
            emit({"type": "progress", "name": name, "value": round(v * scale, 2), "best": round(best * scale, 2), "unit": unit, "extra": list(extra)})
        return cb

    def done(name, data):
        if isinstance(data, dict):
            data["workload"] = {"id": name, "v": WORKLOAD_V}
            w = data.get("work")
            if w:
                works[name] = w
        elif isinstance(data, list):
            works[name] = {"amount": round(sum(x.get("work_gb", 0) for x in data), 3), "unit": "GB"}
        emit({"type": "result", "name": name, "data": data, "workload": {"id": name, "v": WORKLOAD_V}})

    with hw._LOCK, hw.PowerRecorder(emit) as rec:
        def stage(name):
            if cancel.is_set():
                raise hw.Cancelled()
            rec.stage = name
            emit({"type": "stage", "name": name})

        def pause(name, s):
            stage(name)
            end = time.monotonic() + s
            while time.monotonic() < end:
                if cancel.is_set():
                    raise hw.Cancelled()
                time.sleep(0.05)

        if plan.baseline:
            pause("idle", MIN_WINDOW_S)   # a baseline, so each test's power can be read against idle
        if plan.draw:
            pause("draw", MIN_WINDOW_S)   # the page draws its live view from here on
        for comp in plan.only:
            stage(comp)
            if comp == "matmul_1":
                done(comp, hw._matmul(1, P.get("n", 512), prog(comp, "GFLOP/s"), sec, cancel, smp))
            elif comp == "matmul_n":
                done(comp, hw._matmul(P.get("threads", hw.torch.get_num_threads()), P.get("n", 1024), prog(comp, "GFLOP/s"), sec, cancel, smp))
            elif comp == "dram":
                done(comp, hw._dram(prog(comp, "GB/s"), P.get("ram_mb", min(480, caps()["ram_mb"][1])), sec, cancel, smp))
            elif comp == "cache":
                done(comp, hw._cache_curve(prog(comp, "GB/s"), P.get("max_kb", caps()["max_kb"][1]), cancel, smp))
            elif comp == "disk":
                done(comp, hw._disk_bench(P.get("disk_mb", min(256, caps()["disk_mb"][1])), prog(comp, "GB/s"), cancel))
            elif comp == "net":
                done(comp, hw._network(prog(comp, "Mbit/s"), sec if "seconds" in P else 3.0, cancel))
            elif comp == "gpu":
                done(comp, client(comp, cancel) if client else None)
            elif comp == "ai":
                stage("ai_load")                  # the model download is not part of any measured window
                h = hw._ai_holder()
                stage("ai")
                done(comp, hw._ai(h, prog(comp, "tokens/s"), P.get("tokens", 32), cancel))
        if plan.baseline:
            pause("cool", 0.8)
    if rec.samples:
        S = rec.summary()
        per = {}
        for k in plan.only:
            s = S.get(k)
            if not s:
                continue
            ok = s["seconds"] >= MIN_WINDOW_S
            w = works.get(k)
            per[k] = {"joules": s["joules"] if ok else None, "seconds": s["seconds"], "avg_w": s["avg_w"], "peak_w": s["peak_w"], "reliable": ok,
                      "work": w, "per_joule": round(w["amount"] / s["joules"], 4) if (ok and w and s["joules"] > 0) else None}
        emit({"type": "result", "name": "power", "data": {"summary": S, "per_component": per, "samples": rec.samples,
                                                          "source": rec.power.sample(rec.n).get("source")}})
