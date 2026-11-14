"""Smoke test for the hardware layer, run against the real machine and the real model."""
import json
import sys

from app import hw, runner

repo = sys.argv[1] if len(sys.argv) > 1 else "HuggingFaceTB/SmolLM2-135M"
prompt = "The Eiffel Tower is located in the city of"

info = hw.info()
print(json.dumps({k: info[k] for k in ("cpu", "ram", "gpus", "disks", "nics")}, indent=1)[:2600])

print("\n== benchmarks")
bench = {}
for name, res in hw.bench_steps():
    bench[name] = res
    print(name, res if name != "cache" else [(c["kb"], c["gbps"]) for c in res])

peaks = {"gflops": bench["matmul_n"]["gflops"], "gbps": bench["dram"]["copy_gbps"]}
print("\n== journey", repo, "| peaks", peaks)
h = runner.get_holder(repo)
j = hw.journey(h, prompt, 24, peaks)
print("tokenize:", j["tokenize"]["tokens"], j["tokenize"]["us"], "us")
p = j["prefill"]
print(f"prefill: T={p['T']} total {p['total_ms']} ms, {p['flops'] / 1e9:.2f} GFLOP, weights {p['wbytes'] / 1e6:.0f} MB, ops={len(p['ops'])}")
d = j["decode"]
print(f"decode : {d['tps']} tok/s, step {d['step_ms']} ms, weights/token {d['weight_bytes'] / 1e6:.0f} MB -> effective {d['effective_gbps']} GB/s "
      f"({100 * d['effective_gbps'] / peaks['gbps']:.0f}% of measured peak)")
print("ridge (FLOP/B):", d["ridge"], "| decode bound mix:", {b: sum(1 for o in d["ops"] if o["bound"] == b) for b in ("memory", "compute")})
big = sorted(d["ops"], key=lambda o: -o["ms"])[:6]
for o in big:
    print(f"  {o['layer']:>3} {o['name']:<10} {o['ms']:.3f} ms  {o['gflops']:>7} GFLOP/s  {o['gbps']:>6} GB/s  AI={o['ai']}  {o['bound']}")
print("sample:", j["sample"]["chosen"], j["sample"]["top"][:3], "| detok:", repr(j["detok"]["text"]))
print("generated:", repr("".join(t["text"] for t in d["tokens"])))

m = hw.microscope(h, prompt, 0, 0)
print(f"\nmicroscope {m['op']} row {m['row']}: {m['length']} products in {m['fma_instructions']} chunks of {m['lanes']} -> dot {m['dot']} vs module {m['module_output']} (err {m['match_err']:.2e})")
print(" x[:4]", m["x"][:4], " w[:4]", m["w"][:4], " prod[:4]", m["products"][:4])
