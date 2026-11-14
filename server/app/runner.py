"""Load a Hugging Face causal LM, run it with forward hooks, apply reversible edits.

Everything the UI shows comes from a real forward pass:
  * per-layer residual / attention / MLP magnitudes
  * attention patterns, rebuilt from the captured q and k and checked against the
    model's own attention output (`verify.attn_max_err`)
  * the next-token distribution
Edits (head/MLP ablation, neuron silencing, weight scale or set) are applied on the
live model for the duration of one call and always undone afterwards.
"""
from __future__ import annotations

import math
import threading
import time

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

from .adapters import LLAMA_LIKE, SUPPORTED_RUN

torch.set_grad_enabled(False)
MAX_TOKENS = 48


def r(x: torch.Tensor, d: int = 3):
    f = 10**d
    return (torch.round(x.float() * f) / f).tolist()


def rotate_half(x: torch.Tensor) -> torch.Tensor:
    h = x.shape[-1] // 2
    return torch.cat((-x[..., h:], x[..., :h]), dim=-1)


class Arch:
    """Uniform access to the pieces we hook, for llama-like and GPT-2 models."""

    def __init__(self, model):
        self.model = model
        cfg = model.config
        self.mt = cfg.model_type
        self.gpt2 = self.mt == "gpt2"
        self.L = cfg.num_hidden_layers
        self.H = cfg.hidden_size
        self.nh = cfg.num_attention_heads
        self.nkv = getattr(cfg, "num_key_value_heads", None) or self.nh
        self.hd = getattr(cfg, "head_dim", None) or self.H // self.nh
        self.layers = model.transformer.h if self.gpt2 else model.model.layers

    def embed_mod(self):
        return self.model.transformer.drop if self.gpt2 else self.model.model.embed_tokens

    def attn(self, i):
        return self.layers[i].attn if self.gpt2 else self.layers[i].self_attn

    def o_proj(self, i):
        return self.attn(i).c_proj if self.gpt2 else self.attn(i).o_proj

    def mlp(self, i):
        return self.layers[i].mlp

    def down(self, i):
        return self.mlp(i).c_proj if self.gpt2 else self.mlp(i).down_proj

    def qkv_hooks(self, i, store: dict):
        if self.gpt2:
            def hook(_m, _inp, out):
                q, k, v = out.split(self.H, dim=-1)
                store[i] = {"q": q, "k": k, "v": v}
            return [self.attn(i).c_attn.register_forward_hook(hook)]
        a = self.attn(i)

        def mk(key):
            def hook(_m, _inp, out):
                store.setdefault(i, {})[key] = out
            return hook
        return [a.q_proj.register_forward_hook(mk("q")), a.k_proj.register_forward_hook(mk("k")), a.v_proj.register_forward_hook(mk("v"))]

    def heads(self, q, k, T):
        """q,k: [1,T,*] projections -> per-head [nh,T,hd] with RoPE applied and KV repeated."""
        q = q.view(1, T, self.nh, self.hd).transpose(1, 2)
        k = k.view(1, T, self.nkv, self.hd).transpose(1, 2)
        if not self.gpt2:
            pos = torch.arange(T).unsqueeze(0)
            cos, sin = self.model.model.rotary_emb(q, pos)
            cos, sin = cos.unsqueeze(1), sin.unsqueeze(1)
            q = q * cos + rotate_half(q) * sin
            k = k * cos + rotate_half(k) * sin
        rep = self.nh // self.nkv
        if rep > 1:
            k = k.repeat_interleave(rep, dim=1)
        return q[0], k[0]

    def pattern(self, q, k, T):
        qh, kh = self.heads(q, k, T)
        s = (qh @ kh.transpose(-1, -2)) / math.sqrt(self.hd)
        s = s.masked_fill(torch.ones(T, T, dtype=torch.bool).triu(1), float("-inf"))
        return torch.softmax(s, dim=-1), qh, kh


def resolve_param(model, name: str):
    params = dict(model.named_parameters())
    for cand in (name, "transformer." + name, "model." + name):
        if cand in params:
            return cand, params[cand]
    raise ValueError(f"Unknown weight '{name}'.")


class Edits:
    """Context manager that applies edits for one call and undoes them on exit."""

    def __init__(self, arch: Arch, edits: list[dict]):
        self.a, self.edits = arch, edits or []
        self.handles, self.undo = [], []
        for e in self.edits:
            self._validate(e)

    def _validate(self, e):
        a, t = self.a, e.get("type")
        if t in ("ablate_head", "ablate_attn", "ablate_mlp", "zero_neuron"):
            if not 0 <= int(e.get("layer", -1)) < a.L:
                raise ValueError(f"layer must be 0..{a.L - 1}")
        if t == "ablate_head" and not 0 <= int(e.get("head", -1)) < a.nh:
            raise ValueError(f"head must be 0..{a.nh - 1}")
        if t == "zero_neuron":
            n = a.down(int(e["layer"])).weight.shape[1 if not a.gpt2 else 0]
            if not 0 <= int(e.get("index", -1)) < n:
                raise ValueError(f"neuron index must be 0..{n - 1}")
        if t in ("scale_weight", "set_weight"):
            _, p = resolve_param(a.model, e.get("name", ""))
            if t == "set_weight":
                row, col = int(e.get("row", -1)), int(e.get("col", -1))
                if p.ndim != 2 or not (0 <= row < p.shape[0] and 0 <= col < p.shape[1]):
                    raise ValueError(f"row/col out of range for shape {list(p.shape)}")
        if t not in ("ablate_head", "ablate_attn", "ablate_mlp", "zero_neuron", "scale_weight", "set_weight"):
            raise ValueError(f"unknown edit type '{t}'")

    def __enter__(self):
        a = self.a
        for e in self.edits:
            t = e["type"]
            if t == "ablate_head":
                lo, hi = int(e["head"]) * a.hd, (int(e["head"]) + 1) * a.hd

                def pre(_m, args, lo=lo, hi=hi):
                    x = args[0].clone()
                    x[..., lo:hi] = 0
                    return (x,) + tuple(args[1:])
                self.handles.append(a.o_proj(int(e["layer"])).register_forward_pre_hook(pre))
            elif t == "ablate_attn":
                self.handles.append(a.o_proj(int(e["layer"])).register_forward_pre_hook(lambda _m, args: (torch.zeros_like(args[0]),) + tuple(args[1:])))
            elif t == "ablate_mlp":
                self.handles.append(a.mlp(int(e["layer"])).register_forward_hook(lambda _m, _i, out: torch.zeros_like(out)))
            elif t == "zero_neuron":
                idx = int(e["index"])

                def pre(_m, args, idx=idx):
                    x = args[0].clone()
                    x[..., idx] = 0
                    return (x,) + tuple(args[1:])
                self.handles.append(a.down(int(e["layer"])).register_forward_pre_hook(pre))
            elif t == "scale_weight":
                _, p = resolve_param(a.model, e["name"])
                old = p.data.clone()
                p.data.mul_(float(e["factor"]))
                self.undo.append(lambda p=p, old=old: p.data.copy_(old))
            elif t == "set_weight":
                _, p = resolve_param(a.model, e["name"])
                row, col = int(e["row"]), int(e["col"])
                old = p.data[row, col].clone()
                p.data[row, col] = float(e["value"])
                self.undo.append(lambda p=p, row=row, col=col, old=old: p.data.__setitem__((row, col), old))
        return self

    def __exit__(self, *_):
        for h in self.handles:
            h.remove()
        for fn in reversed(self.undo):
            fn()
        self.handles, self.undo = [], []


class Tracer:
    def __init__(self, arch: Arch, on_frame=None, keep_hidden=False):
        self.a, self.on_frame, self.keep_hidden = arch, on_frame, keep_hidden
        self.handles, self.frames = [], []
        self.qkv, self.attn_out, self.mlp_out, self.head_norm, self.mlp_info = {}, {}, {}, {}, {}
        self.patterns, self.hidden_last = {}, []

    def emit(self, fr):
        self.frames.append(fr)
        if self.on_frame:
            self.on_frame(fr)

    def install(self):
        a = self.a
        H = self.handles
        H.append(a.embed_mod().register_forward_hook(lambda _m, _i, out: self.emit({"type": "embed", "norm": r(out[0].norm(dim=-1)), "mean": float(out[0][-1].mean())})))
        for i in range(a.L):
            H += a.qkv_hooks(i, self.qkv)
            H.append(a.attn(i).register_forward_hook(self._attn_out(i)))
            H.append(a.o_proj(i).register_forward_pre_hook(self._head_norm(i)))
            H.append(a.mlp(i).register_forward_hook(self._mlp_out(i)))
            H.append(a.down(i).register_forward_pre_hook(self._mlp_act(i)))
            H.append(a.layers[i].register_forward_hook(self._layer(i)))

    def remove(self):
        for h in self.handles:
            h.remove()
        self.handles = []

    def _attn_out(self, i):
        def hook(_m, _inp, out):
            self.attn_out[i] = (out[0] if isinstance(out, tuple) else out)[0]
        return hook

    def _head_norm(self, i):
        def hook(_m, args):
            x = args[0][0]
            T = x.shape[0]
            self.head_norm[i] = x.view(T, self.a.nh, self.a.hd).norm(dim=-1)[-1]
        return hook

    def _mlp_out(self, i):
        def hook(_m, _inp, out):
            self.mlp_out[i] = out[0]
        return hook

    def _mlp_act(self, i):
        def hook(_m, args):
            x = args[0][0][-1]
            top = x.abs().topk(5)
            self.mlp_info[i] = {"top": [[int(j), round(float(x[j]), 3)] for j in top.indices], "mean": float(x.mean()), "active": float((x > 0).float().mean())}
        return hook

    def _layer(self, i):
        def hook(_m, _inp, out):
            x = out[0] if isinstance(out, tuple) else out
            h = x[0]
            T = h.shape[0]
            P, _, _ = self.a.pattern(self.qkv[i]["q"], self.qkv[i]["k"], T)
            self.patterns[i] = P
            if self.keep_hidden:
                self.hidden_last.append(h[-1].clone())
            self.emit({
                "type": "layer", "i": i,
                "resid_norm": r(h.norm(dim=-1)), "resid_mean": round(float(h[-1].mean()), 4),
                "attn_norm": r(self.attn_out[i].norm(dim=-1)), "mlp_norm": r(self.mlp_out[i].norm(dim=-1)),
                "head_norm": r(self.head_norm[i]), "mlp": self.mlp_info[i], "attn": r(P),
            })
        return hook


class Holder:
    def __init__(self, repo: str):
        t0 = time.perf_counter()
        self.repo = repo
        self.tok = AutoTokenizer.from_pretrained(repo)
        try:
            self.model = AutoModelForCausalLM.from_pretrained(repo, dtype=torch.float32, attn_implementation="eager")
        except TypeError:
            self.model = AutoModelForCausalLM.from_pretrained(repo, torch_dtype=torch.float32, attn_implementation="eager")
        self.model.eval()
        if self.model.config.model_type not in SUPPORTED_RUN:
            raise ValueError(f"model_type '{self.model.config.model_type}' is not supported for live runs.")
        self.arch = Arch(self.model)
        self.lock = threading.RLock()
        self.load_seconds = round(time.perf_counter() - t0, 2)


_HOLDERS: dict[str, Holder] = {}
_LOAD_LOCK = threading.Lock()


def get_holder(repo: str) -> Holder:
    with _LOAD_LOCK:
        if repo not in _HOLDERS:
            _HOLDERS[repo] = Holder(repo)
        return _HOLDERS[repo]


def _topk(h: Holder, probs: torch.Tensor, logits: torch.Tensor, k: int):
    p, idx = probs.topk(k)
    return [{"id": int(i), "token": h.tok.decode([int(i)]), "p": round(float(pp), 5), "logit": round(float(logits[int(i)]), 3)} for pp, i in zip(p, idx)]


def run_trace(h: Holder, prompt: str, edits=None, topk: int = 10, on_frame=None, keep_hidden=False, verify=True):
    enc = h.tok(prompt, return_tensors="pt")
    ids = enc["input_ids"]
    T = ids.shape[1]
    if T == 0:
        raise ValueError("Prompt is empty.")
    if T > MAX_TOKENS:
        raise ValueError(f"Prompt has {T} tokens; the limit is {MAX_TOKENS}.")
    tokens = [h.tok.decode([i]) for i in ids[0].tolist()]
    a = h.arch
    with h.lock:
        tr = Tracer(a, on_frame, keep_hidden)
        t0 = time.perf_counter()
        with Edits(a, edits):
            tr.install()
            try:
                tr.emit({"type": "start", "tokens": tokens, "ids": ids[0].tolist(), "L": a.L, "nh": a.nh, "edits": edits or []})
                out = h.model(**enc, output_attentions=verify)
            finally:
                tr.remove()
        logits = out.logits[0, -1].float()
        probs = torch.softmax(logits, dim=-1)
        err = None
        if verify and getattr(out, "attentions", None):
            err = max(float((tr.patterns[i] - out.attentions[i][0]).abs().max()) for i in range(a.L))
        top = _topk(h, probs, logits, topk)
        entropy = float(-(probs * torch.log(probs.clamp_min(1e-12))).sum())
        tr.emit({"type": "final", "topk": top, "entropy": round(entropy, 3), "verify": {"attn_max_err": err}, "seconds": round(time.perf_counter() - t0, 3)})
    return {"tokens": tokens, "topk": top, "probs": probs, "tracer": tr, "attentions": out.attentions if verify else None, "attn_max_err": err, "T": T}


def generate(h: Holder, prompt: str, edits=None, n: int = 24) -> str:
    enc = h.tok(prompt, return_tensors="pt")
    T = enc["input_ids"].shape[1]
    with h.lock, Edits(h.arch, edits):
        out = h.model.generate(**enc, max_new_tokens=n, do_sample=False, pad_token_id=h.tok.pad_token_id if h.tok.pad_token_id is not None else h.tok.eos_token_id)
    return h.tok.decode(out[0, T:], skip_special_tokens=True)


def compare(h: Holder, prompt: str, edits: list[dict], topk: int = 8, max_new: int = 24):
    base = run_trace(h, prompt, [], topk, keep_hidden=True, verify=False)
    edt = run_trace(h, prompt, edits, topk, keep_hidden=True, verify=False)
    pb, pe = base["probs"], edt["probs"]
    kl = float((pb * (pb.clamp_min(1e-12).log() - pe.clamp_min(1e-12).log())).sum())
    delta = pe - pb
    mv = delta.abs().topk(8).indices.tolist()
    movers = [{"token": h.tok.decode([i]), "id": i, "p_base": round(float(pb[i]), 5), "p_edit": round(float(pe[i]), 5), "delta": round(float(delta[i]), 5)} for i in mv]
    drift = []
    for hb, he in zip(base["tracer"].hidden_last, edt["tracer"].hidden_last):
        drift.append(round(float((he - hb).norm() / hb.norm().clamp_min(1e-9)), 4))
    def layer_norms(tr):
        return [fr["resid_norm"][-1] for fr in tr.frames if fr["type"] == "layer"]
    return {
        "tokens": base["tokens"],
        "edits": edits,
        "baseline": {"topk": base["topk"], "generation": generate(h, prompt, [], max_new), "resid_last": layer_norms(base["tracer"])},
        "edited": {"topk": edt["topk"], "generation": generate(h, prompt, edits, max_new), "resid_last": layer_norms(edt["tracer"])},
        "diff": {"kl": round(kl, 5), "top1_changed": base["topk"][0]["id"] != edt["topk"][0]["id"], "movers": movers, "layer_drift": drift},
    }


def ablation_scan(h: Holder, prompt: str, target_id: int | None = None):
    """Ablate every head (and every MLP) once; report how much the target token's probability drops.

    importance = p_original - p_ablated, so positive means the component helps the target.
    """
    a = h.arch
    enc = h.tok(prompt, return_tensors="pt")
    if enc["input_ids"].shape[1] > MAX_TOKENS:
        raise ValueError(f"Prompt has more than {MAX_TOKENS} tokens.")
    t0 = time.perf_counter()

    def prob(edits):
        with Edits(a, edits):
            lg = h.model(**enc).logits[0, -1].float()
        return torch.softmax(lg, dim=-1)

    with h.lock:
        p0 = prob([])
        tid = int(p0.argmax()) if target_id is None else int(target_id)
        base = float(p0[tid])
        heads = [[round(base - float(prob([{"type": "ablate_head", "layer": l, "head": hd}])[tid]), 5) for hd in range(a.nh)] for l in range(a.L)]
        mlps = [round(base - float(prob([{"type": "ablate_mlp", "layer": l}])[tid]), 5) for l in range(a.L)]
    return {"target": h.tok.decode([tid]), "target_id": tid, "p": round(base, 5), "heads": heads, "mlps": mlps,
            "seconds": round(time.perf_counter() - t0, 2), "forward_passes": a.L * a.nh + a.L + 1}


def calc(h: Holder, prompt: str, layer: int, head: int, qpos: int, edits=None):
    a = h.arch
    if not 0 <= layer < a.L:
        raise ValueError(f"layer must be 0..{a.L - 1}")
    if not 0 <= head < a.nh:
        raise ValueError(f"head must be 0..{a.nh - 1}")
    res = run_trace(h, prompt, edits, topk=5, verify=True)
    tr, T = res["tracer"], res["T"]
    if not 0 <= qpos < T:
        raise ValueError(f"query position must be 0..{T - 1}")
    P, qh, kh = a.pattern(tr.qkv[layer]["q"], tr.qkv[layer]["k"], T)
    rep = a.nh // a.nkv
    kv = head // rep
    v = tr.qkv[layer]["v"].view(1, T, a.nkv, a.hd).transpose(1, 2)[0, kv]
    q = qh[head, qpos]
    K = kh[head, : qpos + 1]
    V = v[: qpos + 1]
    scale = math.sqrt(a.hd)
    scores = (K @ q) / scale
    probs = torch.softmax(scores, dim=-1)
    out = probs @ V
    top = int(probs.argmax())
    model_probs = res["attentions"][layer][0, head, qpos, : qpos + 1]
    return {
        "layer": layer, "head": head, "qpos": qpos, "kv_head": kv, "hd": a.hd,
        "tokens": res["tokens"][: qpos + 1], "query_token": res["tokens"][qpos],
        "q": r(q, 3), "k_top": r(K[top], 3), "top_key": top, "top_key_token": res["tokens"][top],
        "dim_products": r(q * K[top] / scale, 3),
        "scores": r(scores, 3), "probs": r(probs, 4), "v_top": r(V[top], 3), "out": r(out, 3),
        "model_probs": r(model_probs, 4),
        "verify": {"max_abs_err": float((probs - model_probs).abs().max())},
        "scale": round(scale, 4),
    }
