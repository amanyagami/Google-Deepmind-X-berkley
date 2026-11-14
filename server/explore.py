"""Find prompts where the model is confident, and edits that visibly change the answer."""
import sys
import time

from app import runner

repo = sys.argv[1]
prompts = sys.argv[2:]
h = runner.get_holder(repo)
print(f"{repo}: L={h.arch.L} nh={h.arch.nh}")
for p in prompts:
    r = runner.run_trace(h, p, [], 4, verify=False)
    print(f"{p!r:55} ->", [(x["token"], round(x["p"], 3)) for x in r["topk"]])
    print("    gen:", repr(runner.generate(h, p, [], 12)))
