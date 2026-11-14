"""Record replay packs: the real probe, trace, tensors, scan, A/B edits and per-head calculations
for each demo model. The web app plays these back when no backend is running.

Usage: python make_examples.py [id ...]
"""
import json
import sys
import time
from pathlib import Path

from app import runner
from app.main import do_probe, tensor

OUT = Path(__file__).resolve().parents[1] / "web" / "public" / "examples"
OUT.mkdir(parents=True, exist_ok=True)

EXAMPLES = [
    {"id": "smollm2", "title": "SmolLM2-135M", "repo": "HuggingFaceTB/SmolLM2-135M", "prompt": "The Eiffel Tower is located in the city of"},
    {"id": "gpt2", "title": "GPT-2", "repo": "openai-community/gpt2", "prompt": "The Eiffel Tower is located in the city of"},
    {"id": "qwen25", "title": "Qwen2.5-0.5B", "repo": "Qwen/Qwen2.5-0.5B", "prompt": "The Eiffel Tower is located in the city of"},
]


def top(c, key):
    return [(x["token"], round(x["p"], 3)) for x in c[key]["topk"][:3]]


def record(ex):
    t0 = time.perf_counter()
    repo, prompt = ex["repo"], ex["prompt"]
    print(f"\n=== {ex['title']} ({repo})", flush=True)
    probe = do_probe(repo)["result"]
    g = probe["graph"]
    h = runner.get_holder(repo)
    a = h.arch
    print(f" loaded in {h.load_seconds}s  L={a.L} nh={a.nh} nkv={a.nkv} hd={a.hd}", flush=True)

    res = runner.run_trace(h, prompt, [], 10, verify=True)
    frames = res["tracer"].frames
    print(f" run: {len(frames)} frames, attention rebuild max err = {res['attn_max_err']}", flush=True)
    # negative control: patterns of layer 0 must NOT match the model's layer-1 attention
    ctrl = float((res["tracer"].patterns[0] - res["attentions"][1][0]).abs().max())
    assert ctrl > 1e-3, "verification would pass trivially"
    print(f" negative control (layer0 patterns vs layer1 attentions) differs by {ctrl:.3f}  -> check is meaningful", flush=True)
    print(" top:", [(x["token"], round(x["p"], 3)) for x in res["topk"][:5]], flush=True)

    scan = runner.ablation_scan(h, prompt)
    print(f" scan: {scan['forward_passes']} passes in {scan['seconds']}s, target {scan['target']!r} p={scan['p']}", flush=True)
    cells = sorted(((v, l, hd) for l, row in enumerate(scan["heads"]) for hd, v in enumerate(row)), reverse=True)
    mlps = sorted(((v, l) for l, v in enumerate(scan["mlps"])), reverse=True)
    best_l = cells[0][1]

    scenarios = [
        ("Ablate the most important head", [{"type": "ablate_head", "layer": cells[0][1], "head": cells[0][2]}]),
        ("Ablate the top 3 heads", [{"type": "ablate_head", "layer": l, "head": hd} for _, l, hd in cells[:3]]),
        (f"Silence the MLP in layer {mlps[2][1]}", [{"type": "ablate_mlp", "layer": mlps[2][1]}]),
    ]
    compares = []
    for label, edits in scenarios:
        c = runner.compare(h, prompt, edits, 6, 16)
        print(f" A/B [{label}] kl={c['diff']['kl']}  {top(c, 'baseline')} -> {top(c, 'edited')}", flush=True)
        compares.append({"label": label, "edits": edits, "result": c})

    layers = sorted({0, best_l, a.L // 2, a.L - 1})
    calcs = []
    for l in layers:
        for hd in range(a.nh):
            c = runner.calc(h, prompt, l, hd, len(res["tokens"]) - 1)
            calcs.append(c)
    worst = max(c["verify"]["max_abs_err"] for c in calcs)
    print(f" calcs: {len(calcs)} heads over layers {layers}, worst |rebuilt - model| = {worst:.2e}", flush=True)

    names = []
    for l in layers:
        b = g["blocks"][l]
        names += [t["name"] for t in b["attn"] + b["mlp"] if len(t["shape"]) == 2 and not t["buffer"]]
    tensors = {n: tensor(repo, n, rows=256, size=32) for n in names}
    print(f" tensors: {len(tensors)} heatmaps recorded", flush=True)

    pack = {**ex, "probe": probe, "run": {"frames": frames}, "scan": scan, "compares": compares,
            "calcs": calcs, "tensors": tensors, "calc_layers": layers, "recorded_with": {"load_seconds": h.load_seconds}}
    path = OUT / f"{ex['id']}.json"
    path.write_text(json.dumps(pack, separators=(",", ":")), encoding="utf-8")
    print(f" wrote {path.name}: {path.stat().st_size / 1e3:.0f} KB in {time.perf_counter() - t0:.0f}s", flush=True)


if __name__ == "__main__":
    want = set(sys.argv[1:])
    done = []
    for ex in EXAMPLES:
        if want and ex["id"] not in want:
            continue
        record(ex)
        done.append(ex)
    index = [{k: e[k] for k in ("id", "title", "repo", "prompt")} | {"file": f"{e['id']}.json"} for e in EXAMPLES if (OUT / f"{e['id']}.json").exists()]
    (OUT / "index.json").write_text(json.dumps(index, indent=1), encoding="utf-8")
    print("\nindex:", [e["id"] for e in index])
