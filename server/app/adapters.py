"""Map safetensors tensor names to a typed block graph.

Supported families get a precise graph (embed, N blocks of norm/attn/mlp, head).
Anything else with numbered layers falls back to a generic block view, and
everything without numbered layers falls back to name-grouped tensors.
"""
from __future__ import annotations

import math
import re

from .hub import itemsize

LLAMA_LIKE = {"llama", "qwen2", "mistral"}
SUPPORTED_RUN = LLAMA_LIKE | {"gpt2"}

_BLOCK_RE = re.compile(r"(?:^|\.)(?:layers|h|blocks|layer)\.(\d+)\.(.+)$")


def _is_buffer(name: str, shape: list) -> bool:
    """Non-parameter tensors some checkpoints store: causal masks and rotary tables."""
    return (name.endswith(("attn.bias", "attn.masked_bias")) and len(shape) >= 3) or name.endswith("inv_freq")


def _tinfo(name: str, e: dict) -> dict:
    n = int(math.prod(e["shape"])) if e["shape"] else 1
    return {"name": name, "shape": e["shape"], "dtype": e["dtype"], "numel": n, "bytes": n * itemsize(e["dtype"]),
            "buffer": _is_buffer(name, e["shape"])}


def _classify_block_tensor(sub: str) -> str:
    s = sub.lower()
    if s.startswith(("self_attn", "attn", "attention")) or "attn" in s.split(".")[0]:
        return "attn"
    if s.startswith(("mlp", "feed_forward", "ffn")):
        return "mlp"
    return "norm"


def _role(prefix: str) -> str:
    p = prefix.lower()
    if any(k in p for k in ("vision", "visual", "image", "vit", "siglip", "clip_vision", "patch")):
        return "vision"
    if any(k in p for k in ("audio", "whisper", "speech")):
        return "audio"
    return "text"


def _stacks(tensors: dict) -> list[dict]:
    """Numbered layers grouped by their name prefix, so a VLM's vision tower and language model stay separate."""
    by: dict[str, dict[int, dict]] = {}
    for name, t in tensors.items():
        m = _BLOCK_RE.search(name)
        if not m:
            continue
        prefix = name[:m.start()].rstrip(".")
        b = by.setdefault(prefix, {}).setdefault(int(m.group(1)), {"i": int(m.group(1)), "attn": [], "mlp": [], "norm": []})
        b[_classify_block_tensor(m.group(2))].append(t)
    out = []
    for prefix, blocks in by.items():
        bl = [blocks[i] for i in sorted(blocks)]
        for b in bl:
            b["params"] = sum(t["numel"] for k in ("attn", "mlp", "norm") for t in b[k] if not t["buffer"])
        out.append({"prefix": prefix, "role": _role(prefix), "blocks": bl, "params": sum(b["params"] for b in bl)})
    # the language model first (it is what runs and writes), then the rest by size
    out.sort(key=lambda st: (st["role"] != "text", -st["params"]))
    return out


_CONNECTOR = ("multi_modal_projector", "mm_projector", "connector", "visual.merger", "vision_proj", "modality_projection")


def build_graph(repo: str, config: dict, header: dict, kinds: dict) -> dict:
    mt = config.get("model_type", "unknown")
    arch_names = config.get("architectures") or []
    tensors = {n: _tinfo(n, e) for n, e in header.items()}
    total_params = sum(t["numel"] for t in tensors.values() if not t["buffer"])
    total_bytes = sum(t["bytes"] for t in tensors.values())

    embed, head, final_norm = [], [], []
    blocks: dict[int, dict] = {}
    other: list = []
    for name, t in tensors.items():
        m = _BLOCK_RE.search(name)
        if m:
            i = int(m.group(1))
            b = blocks.setdefault(i, {"i": i, "attn": [], "mlp": [], "norm": []})
            b[_classify_block_tensor(m.group(2))].append(t)
        elif any(k in name for k in ("embed_tokens", "wte", "wpe", "word_embeddings", "embeddings")):
            embed.append(t)
        elif "lm_head" in name or name.endswith("output.weight"):
            head.append(t)
        elif "norm" in name or "ln_f" in name:
            final_norm.append(t)
        else:
            other.append(t)

    stacks = _stacks(tensors)
    if len(stacks) > 1:
        block_list = stacks[0]["blocks"]  # the main stack keeps the classic single-stack view and live runs working
    else:
        block_list = [blocks[i] for i in sorted(blocks)]
        for b in block_list:
            b["params"] = sum(t["numel"] for k in ("attn", "mlp", "norm") for t in b[k] if not t["buffer"])
    connector = [t for t in other if any(k in t["name"] for k in _CONNECTOR)]

    runnable = mt in SUPPORTED_RUN
    if mt in LLAMA_LIKE:
        adapter, family = "LlamaAdapter", "llama-like"
    elif mt == "gpt2":
        adapter, family = "GPT2Adapter", "gpt2"
    elif block_list:
        adapter, family = "GenericBlockAdapter", "generic-blocks"
    else:
        adapter, family = "TensorTreeAdapter", "tensor-tree"

    dims = {}
    if runnable:
        H = config.get("hidden_size") or config.get("n_embd")
        nh = config.get("num_attention_heads") or config.get("n_head")
        dims = {
            "L": config.get("num_hidden_layers") or config.get("n_layer"),
            "H": H,
            "nh": nh,
            "nkv": config.get("num_key_value_heads", nh),
            "hd": config.get("head_dim") or (H // nh),
            "I": config.get("intermediate_size") or config.get("n_inner") or 4 * H,
            "V": config.get("vocab_size"),
            "tied": bool(config.get("tie_word_embeddings", mt == "gpt2")),
        }

    tier = 1 if runnable else (3 if block_list else 3)
    notes = []
    if kinds.get("pickle") and not kinds.get("safetensors"):
        notes.append("Only pickle checkpoints found. Refused: loading pickle can run code.")
    if not runnable:
        notes.append(f"model_type '{mt}' has no run adapter yet. Structure and tensor heatmaps are available; live trace is not.")

    return {
        "repo": repo,
        "model_type": mt,
        "class": arch_names[0] if arch_names else None,
        "adapter": adapter,
        "family": family,
        "runnable": runnable,
        "tier": tier,
        "dims": dims,
        "params": total_params,
        "bytes": total_bytes,
        "tensor_count": len(tensors),
        "embed": embed,
        "head": head,
        "final_norm": final_norm,
        "other": other,
        "blocks": block_list,
        "stacks": [{"prefix": st["prefix"], "role": st["role"], "params": st["params"], "count": len(st["blocks"]),
                    "block_params": [b["params"] for b in st["blocks"]]} for st in stacks],
        "connector": {"params": sum(t["numel"] for t in connector), "tensors": [t["name"] for t in connector]} if connector else None,
        "notes": notes,
    }
