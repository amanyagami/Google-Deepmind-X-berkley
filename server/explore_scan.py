import sys

from app import runner

repo, prompt = sys.argv[1], sys.argv[2]
h = runner.get_holder(repo)
s = runner.ablation_scan(h, prompt)
print(f"{repo} | target {s['target']!r} p={s['p']} | {s['forward_passes']} forward passes in {s['seconds']}s")
cells = sorted(((v, l, hd) for l, row in enumerate(s["heads"]) for hd, v in enumerate(row)), reverse=True)
print("top heads (importance = p_before - p_after):", [(l, hd, round(v, 3)) for v, l, hd in cells[:8]])
mlps = sorted(((v, l) for l, v in enumerate(s["mlps"])), reverse=True)
print("top MLPs:", [(l, round(v, 3)) for v, l in mlps[:6]])

# try edits that should flip the answer
def show(edits, label):
    c = runner.compare(h, prompt, edits, 5, 12)
    print(f"\n[{label}] {edits}")
    print("  before:", [(x["token"], round(x["p"], 3)) for x in c["baseline"]["topk"]], repr(c["baseline"]["generation"]))
    print("  after :", [(x["token"], round(x["p"], 3)) for x in c["edited"]["topk"]], repr(c["edited"]["generation"]))
    print("  kl", c["diff"]["kl"], "flipped", c["diff"]["top1_changed"])

best_h = [{"type": "ablate_head", "layer": l, "head": hd} for v, l, hd in cells[:1]]
show(best_h, "best single head")
show([{"type": "ablate_head", "layer": l, "head": hd} for v, l, hd in cells[:3]], "top-3 heads")
show([{"type": "ablate_mlp", "layer": l} for v, l in mlps[:2]], "top-2 MLPs")
show([{"type": "ablate_head", "layer": l, "head": hd} for v, l, hd in cells[:3]] + [{"type": "ablate_mlp", "layer": mlps[0][1]}], "top-3 heads + top MLP")
