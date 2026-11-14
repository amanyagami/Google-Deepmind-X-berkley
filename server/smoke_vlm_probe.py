"""Header-only probe of a real small VLM: the vision tower and the language model must come out as separate stacks."""
from app import hub
from app.adapters import build_graph

for repo in ["HuggingFaceTB/SmolVLM-256M-Instruct", "HuggingFaceTB/SmolLM2-135M"]:
    st = hub.ReadStats()
    files = hub.list_files(repo, st)
    kinds = hub.classify_files(files)
    cfg = hub.get_json(f"{hub.HF}/{repo}/resolve/main/config.json", "config.json", st)
    hdr = hub.read_all_headers(repo, files, st)
    g = build_graph(repo, cfg, hdr, kinds)
    print(repo, "| params", f"{g['params']:,}", "| read", st.bytes_read, "bytes in", st.requests, "requests")
    for s in g["stacks"]:
        print(f"   {s['role']:6s} {s['prefix']:40s} {s['count']:3d} blocks {s['params']:>12,} params")
    print("   connector:", g["connector"])
