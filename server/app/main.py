"""Neural Studio API.

  GET  /api/health
  GET  /api/probe?repo=...          config + safetensors header via Range, typed graph, zero weights downloaded
  GET  /api/tensor?repo=&name=      heatmap of one tensor, fetched by byte range
  POST /api/load                    download weights and load the model for live runs
  POST /api/run                     full trace (non-streaming)
  POST /api/compare                 baseline vs edited, with generation and layer drift
  POST /api/calc                    the arithmetic of one attention head at one position
  WS   /ws/run                      streams one frame per layer while the forward pass runs
"""
from __future__ import annotations

import asyncio
import os
import queue
import threading
import time
from pathlib import Path

import numpy as np
from fastapi import FastAPI, Query, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import hub
from .adapters import build_graph

app = FastAPI(title="Neural Studio", version="0.2.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# Optional shared secret. Set NEURAL_STUDIO_TOKEN when the server listens beyond localhost; every /api and /ws
# request must then carry ?token=... or an X-Studio-Token header. Unset (the default), localhost use is open.
_TOKEN = os.environ.get("NEURAL_STUDIO_TOKEN") or None


@app.middleware("http")
async def guard(request, call_next):
    if request.method == "OPTIONS":
        resp = await call_next(request)
        # lets a hosted copy of the web app (https) call this companion on 127.0.0.1 (Chrome Private Network Access)
        resp.headers["Access-Control-Allow-Private-Network"] = "true"
        return resp
    if _TOKEN and request.url.path.startswith("/api") and _TOKEN not in (request.headers.get("x-studio-token"), request.query_params.get("token")):
        return JSONResponse({"error": "token required"}, status_code=401)
    resp = await call_next(request)
    resp.headers["Access-Control-Allow-Private-Network"] = "true"
    return resp


async def _ws_ok(ws: WebSocket) -> bool:
    if _TOKEN and ws.query_params.get("token") != _TOKEN:
        await ws.close(code=4401)
        return False
    return True

_PROBES: dict[str, dict] = {}


@app.exception_handler(hub.HubError)
async def hub_error(_req, exc: hub.HubError):
    return JSONResponse({"error": exc.message}, status_code=exc.status)


@app.exception_handler(ValueError)
async def value_error(_req, exc: ValueError):
    return JSONResponse({"error": str(exc)}, status_code=400)


@app.get("/api/health")
def health():
    import torch
    import transformers
    from . import runner
    return {"ok": True, "torch": torch.__version__, "transformers": transformers.__version__, "loaded": list(runner._HOLDERS)}


def do_probe(repo: str) -> dict:
    if repo in _PROBES:
        return _PROBES[repo]
    t0 = time.perf_counter()
    stats = hub.ReadStats()
    files = hub.list_files(repo, stats)
    kinds = hub.classify_files(files)
    if not kinds["safetensors"]:
        why = "Only pickle checkpoints were found. Refused: loading pickle can execute code." if kinds["pickle"] else \
              "GGUF files are not supported yet." if kinds["gguf"] else "No safetensors weights found."
        raise hub.HubError(422, why)
    config = hub.get_json(f"{hub.HF}/{repo}/resolve/main/config.json", "config.json", stats)
    header = hub.read_all_headers(repo, files, stats)
    graph = build_graph(repo, config, header, kinds)
    result = {
        "repo": repo,
        "config": {k: config.get(k) for k in ("model_type", "architectures", "hidden_size", "num_hidden_layers", "num_attention_heads", "num_key_value_heads", "intermediate_size", "vocab_size", "tie_word_embeddings", "n_embd", "n_layer", "n_head")},
        "files": kinds,
        "read": {"requests": stats.requests, "bytes": stats.bytes_read, "log": stats.log, "seconds": round(time.perf_counter() - t0, 2), "weights_downloaded": 0},
        "graph": graph,
    }
    _PROBES[repo] = {"result": result, "header": header}
    return _PROBES[repo]


@app.get("/api/probe")
def probe(repo: str = Query(...)):
    return do_probe(hub.parse_repo(repo))["result"]


@app.get("/api/tensor")
def tensor(repo: str, name: str, rows: int = 256, size: int = 48):
    repo = hub.parse_repo(repo)
    header = do_probe(repo)["header"]
    if name not in header:
        raise hub.HubError(404, f"Tensor '{name}' not found.")
    e = header[name]
    stats = hub.ReadStats()
    t0 = time.perf_counter()
    arr, rows_read = hub.read_tensor_rows(repo, e, max(1, min(rows, 1024)), stats)
    total = int(np.prod(e["shape"])) * hub.itemsize(e["dtype"]) if e["shape"] else hub.itemsize(e["dtype"])
    if len(e["shape"]) == 1:  # 1-D tensors are read as one row of elements
        rows_read = int(arr.shape[1])
    return {
        "name": name, "shape": e["shape"], "dtype": e["dtype"], "rows_read": rows_read, "rows_total": e["shape"][0] if e["shape"] else 1,
        "stats": {"mean": round(float(arr.mean()), 5), "std": round(float(arr.std()), 5), "min": round(float(arr.min()), 4), "max": round(float(arr.max()), 4)},
        "heat": hub.heatmap(arr, max(8, min(size, 96))),
        "fetched_bytes": stats.bytes_read, "tensor_bytes": total, "seconds": round(time.perf_counter() - t0, 3),
    }


class LoadReq(BaseModel):
    repo: str


class RunReq(BaseModel):
    repo: str
    prompt: str
    edits: list[dict] = Field(default_factory=list)
    topk: int = 10


class CompareReq(RunReq):
    max_new: int = 24


class CalcReq(BaseModel):
    repo: str
    prompt: str
    layer: int
    head: int
    qpos: int = -1
    edits: list[dict] = Field(default_factory=list)


@app.post("/api/load")
def load(req: LoadReq):
    from . import runner
    repo = hub.parse_repo(req.repo)
    if repo not in runner._HOLDERS:
        do_probe(repo)
    h = runner.get_holder(repo)
    a = h.arch
    return {"repo": repo, "loaded": True, "load_seconds": h.load_seconds, "L": a.L, "H": a.H, "nh": a.nh, "nkv": a.nkv, "hd": a.hd}


@app.post("/api/run")
def run(req: RunReq):
    from . import runner
    h = runner.get_holder(hub.parse_repo(req.repo))
    res = runner.run_trace(h, req.prompt, req.edits, req.topk)
    return {"frames": res["tracer"].frames}


@app.post("/api/compare")
def compare(req: CompareReq):
    from . import runner
    h = runner.get_holder(hub.parse_repo(req.repo))
    return runner.compare(h, req.prompt, req.edits, req.topk, req.max_new)


@app.post("/api/calc")
def calc(req: CalcReq):
    from . import runner
    h = runner.get_holder(hub.parse_repo(req.repo))
    qpos = req.qpos
    if qpos < 0:
        qpos = len(h.tok(req.prompt)["input_ids"]) + qpos
    return runner.calc(h, req.prompt, req.layer, req.head, qpos, req.edits)


class JourneyReq(BaseModel):
    repo: str
    prompt: str
    new_tokens: int = 16
    peak_gflops: float | None = None
    peak_gbps: float | None = None


class MicroReq(BaseModel):
    repo: str
    prompt: str
    layer: int = 0
    row: int = 0


@app.get("/api/hw/info")
def hw_info():
    from . import hw
    return hw.info()


@app.get("/api/hw/power")
def hw_power():
    from . import hw, power
    return power.sample(hw.info()["cpu"]["cores"])


@app.post("/api/hw/journey")
def hw_journey(req: JourneyReq):
    from . import hw, runner
    h = runner.get_holder(hub.parse_repo(req.repo))
    info = hw.info()
    pg = req.peak_gflops or info["cpu"]["peak_gflops_est"]
    pb = req.peak_gbps or info["ram"]["peak_gbps_est"] or 0
    return hw.journey(h, req.prompt, max(2, min(req.new_tokens, 64)), {"gflops": pg, "gbps": pb})


@app.post("/api/hw/microscope")
def hw_microscope(req: MicroReq):
    from . import hw, runner
    h = runner.get_holder(hub.parse_repo(req.repo))
    return hw.microscope(h, req.prompt, req.layer, req.row)


@app.websocket("/ws/telemetry")
async def ws_telemetry(ws: WebSocket):
    """10 Hz live samples of the machine: per-core load, memory, disk and network rates."""
    from . import hw
    if not await _ws_ok(ws):
        return
    await ws.accept()
    hw.telemetry()  # prime the counters
    try:
        while True:
            await asyncio.sleep(0.1)
            await ws.send_json(hw.telemetry())
    except Exception:  # noqa: BLE001 - client went away
        pass


@app.websocket("/ws/bench")
async def ws_bench(ws: WebSocket):
    """Run the microbenchmarks and stream each result as it completes."""
    from . import hw
    if not await _ws_ok(ws):
        return
    await ws.accept()
    q: queue.SimpleQueue = queue.SimpleQueue()
    replies: dict[str, object] = {}
    got = threading.Event()

    def client(name: str):
        """Ask the browser to run `name` (e.g. the WebGPU test) and wait for its result."""
        got.clear()
        q.put({"type": "client_task", "name": name})
        got.wait(timeout=90)
        return replies.pop(name, None)

    def work():
        try:
            hw.bench_run(q.put, client)
            q.put({"type": "done"})
        except Exception as e:  # noqa: BLE001
            q.put({"type": "error", "message": str(e)})

    async def listen():
        try:
            while True:
                m = await ws.receive_json()
                if m.get("type") == "client_result":
                    replies[m["name"]] = m.get("data")
                    got.set()
        except Exception:  # noqa: BLE001 - socket closed
            got.set()

    listener = asyncio.create_task(listen())
    try:
        threading.Thread(target=work, daemon=True).start()
        while True:
            try:
                item = q.get_nowait()
            except queue.Empty:
                await asyncio.sleep(0.02)
                continue
            await ws.send_json(item)
            if item["type"] in ("done", "error"):
                break
    except Exception:  # noqa: BLE001
        pass
    finally:
        listener.cancel()
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass


class ScanReq(BaseModel):
    repo: str
    prompt: str
    target_id: int | None = None


@app.post("/api/scan")
def scan(req: ScanReq):
    from . import runner
    h = runner.get_holder(hub.parse_repo(req.repo))
    return runner.ablation_scan(h, req.prompt, req.target_id)


@app.websocket("/ws/run")
async def ws_run(ws: WebSocket):
    from . import runner
    if not await _ws_ok(ws):
        return
    await ws.accept()
    try:
        msg = await ws.receive_json()
        repo = hub.parse_repo(msg["repo"])
        await ws.send_json({"type": "status", "message": "Loading model" if repo not in runner._HOLDERS else "Running"})
        q: queue.SimpleQueue = queue.SimpleQueue()

        def work():
            try:
                h = runner.get_holder(repo)
                runner.run_trace(h, msg["prompt"], msg.get("edits") or [], int(msg.get("topk", 10)), on_frame=q.put)
                q.put({"type": "done"})
            except Exception as e:  # noqa: BLE001 - surfaced to the client
                q.put({"type": "error", "message": str(e)})

        threading.Thread(target=work, daemon=True).start()
        while True:
            try:
                item = q.get_nowait()
            except queue.Empty:
                await asyncio.sleep(0.004)
                continue
            await ws.send_json(item)
            if item["type"] in ("done", "error"):
                break
    except Exception as e:  # noqa: BLE001
        try:
            await ws.send_json({"type": "error", "message": str(e)})
        except Exception:  # noqa: BLE001
            pass
    finally:
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass


_DIST = Path(__file__).resolve().parents[2] / "web" / "dist"
if _DIST.exists():
    app.mount("/", StaticFiles(directory=_DIST, html=True), name="web")
