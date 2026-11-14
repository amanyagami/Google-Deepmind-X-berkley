"""Record the Machine-view pack the web app plays when no companion is running (browser-only / hosted mode).

Contents, all measured on this PC: hardware info, the full benchmark with its RAPL power trace, one instrumented
journey through SmolLM2-135M, and one real dot product for the core microscope.
Writes web/public/examples/machine.json.
"""
import json
import time
from pathlib import Path

from app import hw, runner

REPO = "HuggingFaceTB/SmolLM2-135M"
PROMPT = "The capital of France is"

events = []
t = time.time()
hw.bench_run(events.append)  # no browser here, so no GPU stage
bench = {m["name"]: m["data"] for m in events if m["type"] == "result" and m["name"] != "power"}
power = next((m["data"] for m in events if m["type"] == "result" and m["name"] == "power"), None)
print(f"bench {time.time() - t:.0f} s, power samples {len(power['samples']) if power else 0}")

h = runner.get_holder(REPO)
pk = {"gflops": bench["matmul_n"]["gflops"], "gbps": bench["dram"]["copy_gbps"]}
journey = hw.journey(h, PROMPT, 24, pk)
micro = hw.microscope(h, PROMPT, 0, 0)
info = dict(hw.info())
pack = {"recorded": time.strftime("%Y-%m-%d"), "note": "Recorded on the test PC by server/make_machine_pack.py",
        "info": info, "bench": bench, "power": power, "journey": journey, "micro": micro}
out = Path(__file__).resolve().parents[1] / "web" / "public" / "examples" / "machine.json"
out.write_text(json.dumps(pack, separators=(",", ":")), encoding="utf-8")
print(f"wrote {out} ({out.stat().st_size / 1e6:.2f} MB) · decode {journey['decode']['tps']} tok/s · micro err {micro['match_err']:.2e}")
