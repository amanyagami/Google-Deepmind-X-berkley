import json, time
from app import hw
t=time.time(); info=hw.info(); print("info", round(time.time()-t,1), "s pcie", info["pcie"], "power", info["power"])
ev=[]
hw.bench_run(ev.append)
res={m["name"]:m["data"] for m in ev if m["type"]=="result"}
for k,v in res.items():
    if k=="power":
        print("power samples", len(v["samples"]))
        for st,d in v["summary"].items(): print(f"  {st:9s} {d}")
    elif k=="cache": print(k, v[0], v[-1])
    else: print(k, v)
print("power events", sum(1 for m in ev if m["type"]=="power"))
