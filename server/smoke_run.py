"""Smoke test: load a real model, trace a prompt, verify attention reconstruction, compare an edit, open one head."""
import json
import sys
import time

from app import runner

repo = sys.argv[1] if len(sys.argv) > 1 else "HuggingFaceTB/SmolLM2-135M"
prompt = sys.argv[2] if len(sys.argv) > 2 else "The capital of France is"

t = time.perf_counter()
h = runner.get_holder(repo)
print(f"loaded {repo} in {h.load_seconds}s  L={h.arch.L} H={h.arch.H} nh={h.arch.nh} nkv={h.arch.nkv} hd={h.arch.hd}")

res = runner.run_trace(h, prompt, [], 8)
fr = res["tracer"].frames
print("frames:", [f["type"] for f in fr][:3], "...", len(fr), "total")
print("tokens:", res["tokens"])
print("attention reconstruction vs model (max abs err):", res["attn_max_err"])
print("top-8:", [(x["token"], round(x["p"], 3)) for x in res["topk"]])
last = [f for f in fr if f["type"] == "layer"][-1]
print("last layer keys:", sorted(last.keys()), "| attn shape:", len(last["attn"]), "x", len(last["attn"][0]), "x", len(last["attn"][0][0]))

print("\n-- generation (baseline):", repr(runner.generate(h, prompt, [], 16)))

L = h.arch.L
edits = [{"type": "ablate_mlp", "layer": L // 2}]
c = runner.compare(h, prompt, edits, 6, 16)
print("\n-- compare:", edits)
print(" base :", [(x["token"], round(x["p"], 3)) for x in c["baseline"]["topk"]], repr(c["baseline"]["generation"]))
print(" edit :", [(x["token"], round(x["p"], 3)) for x in c["edited"]["topk"]], repr(c["edited"]["generation"]))
print(" kl:", c["diff"]["kl"], "top1_changed:", c["diff"]["top1_changed"])
print(" layer drift:", c["diff"]["layer_drift"][:6], "...", c["diff"]["layer_drift"][-3:])

# model must be restored exactly after edits
again = runner.run_trace(h, prompt, [], 3, verify=False)
print("restored:", [(x["token"], round(x["p"], 3)) for x in again["topk"]] == [(x["token"], round(x["p"], 3)) for x in res["topk"][:3]])

cc = runner.calc(h, prompt, L - 1, 0, len(res["tokens"]) - 1)
print("\n-- calc layer", cc["layer"], "head", cc["head"], "query", repr(cc["query_token"]), "-> top key", repr(cc["top_key_token"]))
print(" probs:", cc["probs"], "| model probs:", cc["model_probs"], "| err:", cc["verify"]["max_abs_err"])
print(" q[:6]:", cc["q"][:6], " sum(dim_products)=", round(sum(cc["dim_products"]), 4), "= score", cc["scores"][cc["top_key"]])
