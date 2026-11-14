"""Smoke test: header-only probe and single-tensor Range read. No model weights are downloaded."""
import json
import sys

from app import hub
from app.main import do_probe, tensor

for repo in sys.argv[1:] or ["HuggingFaceTB/SmolLM2-135M"]:
    p = do_probe(repo)["result"]
    g = p["graph"]
    print(f"\n== {repo}")
    print(" adapter:", g["adapter"], "| family:", g["family"], "| runnable:", g["runnable"], "| tier:", g["tier"])
    print(" params from header:", f"{g['params']:,}", "| tensors:", g["tensor_count"], "| blocks:", len(g["blocks"]))
    print(" dims:", g["dims"])
    print(" read:", p["read"]["requests"], "requests,", p["read"]["bytes"], "bytes,", p["read"]["seconds"], "s, weights downloaded:", p["read"]["weights_downloaded"])
    for e in p["read"]["log"]:
        print("   ", e)
    b0 = g["blocks"][0]
    print(" block0 attn:", [(t["name"].split(".", 2)[-1], t["shape"]) for t in b0["attn"]])
    print(" block0 mlp :", [(t["name"].split(".", 2)[-1], t["shape"]) for t in b0["mlp"]])
    name = b0["attn"][0]["name"]
    t = tensor(repo, name, rows=256, size=24)
    print(" tensor", name, t["shape"], t["dtype"], "rows_read", t["rows_read"], "of", t["rows_total"],
          "| fetched", t["fetched_bytes"], "bytes of", t["tensor_bytes"], "| stats", t["stats"], "| heat", len(t["heat"]), "x", len(t["heat"][0]))
