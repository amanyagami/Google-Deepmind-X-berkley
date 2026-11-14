"""Train the model zoo: five tiny networks on scikit-learn's 8x8 handwritten digits, exported for the browser.

  mlp  64 -> 32 -> 16 -> 10                          plain neural network
  cnn  conv 8@3x3 -> pool -> conv 16@3x3 -> pool -> 10  convolutional network
  rnn  GRU reads the image one row (8 pixels) at a time, hidden 24 -> 10
  vit  16 patches of 2x2 pixels, 1 transformer block (2 heads), class token -> 10
  vlm  a ViT vision tower -> connector -> a 1-block text decoder that writes
       "this is a/an <digit> , it is even/odd <eos>" one word at a time ("an" only before "eight")

Everything the browser shows is recomputed there from these weights; `reference` holds PyTorch's own
activations for a few test images so the browser implementation can be checked number for number.
Writes web/public/zoo/<name>.json and web/public/zoo/digits.json.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from sklearn.datasets import load_digits

torch.manual_seed(0)
np.random.seed(0)
OUT = Path(__file__).resolve().parents[1] / "web" / "public" / "zoo"
OUT.mkdir(parents=True, exist_ok=True)

d = load_digits()
X = torch.tensor(d.images / 16.0, dtype=torch.float32)          # (1797, 8, 8) in 0..1
Y = torch.tensor(d.target, dtype=torch.long)
perm = torch.randperm(len(X))
tr, te = perm[:1500], perm[1500:]
NAMES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]


# ------------------------------------------------------------------------------------------ models
class MLP(nn.Module):
    def __init__(self):
        super().__init__()
        self.fc1, self.fc2, self.fc3 = nn.Linear(64, 32), nn.Linear(32, 16), nn.Linear(16, 10)

    def forward(self, x, trace=None):
        x = x.reshape(len(x), 64)
        h1 = F.relu(self.fc1(x)); h2 = F.relu(self.fc2(h1)); o = self.fc3(h2)
        if trace is not None:
            trace.update(input=x, h1=h1, h2=h2, logits=o)
        return o


class CNN(nn.Module):
    def __init__(self):
        super().__init__()
        self.c1, self.c2, self.fc = nn.Conv2d(1, 8, 3, padding=1), nn.Conv2d(8, 16, 3, padding=1), nn.Linear(64, 10)

    def forward(self, x, trace=None):
        x = x.reshape(len(x), 1, 8, 8)
        a1 = F.relu(self.c1(x)); p1 = F.max_pool2d(a1, 2)
        a2 = F.relu(self.c2(p1)); p2 = F.max_pool2d(a2, 2)
        o = self.fc(p2.reshape(len(x), 64))
        if trace is not None:
            trace.update(input=x, conv1=a1, pool1=p1, conv2=a2, pool2=p2, logits=o)
        return o


class RNN(nn.Module):
    H = 24

    def __init__(self):
        super().__init__()
        self.gru = nn.GRUCell(8, self.H)
        self.fc = nn.Linear(self.H, 10)

    def forward(self, x, trace=None):
        x = x.reshape(len(x), 8, 8)
        h = torch.zeros(len(x), self.H)
        hs = []
        for t in range(8):
            h = self.gru(x[:, t], h)
            hs.append(h)
        o = self.fc(h)
        if trace is not None:
            trace.update(input=x, hidden=torch.stack(hs, 1), logits=o)
        return o


class Block(nn.Module):
    """Pre-norm transformer block. `causal_from`: positions >= this index may only look backwards."""

    def __init__(self, D, heads, M):
        super().__init__()
        self.D, self.nh, self.hd = D, heads, D // heads
        self.ln1, self.ln2 = nn.LayerNorm(D), nn.LayerNorm(D)
        self.qkv, self.proj = nn.Linear(D, 3 * D), nn.Linear(D, D)
        self.fc1, self.fc2 = nn.Linear(D, M), nn.Linear(M, D)

    def forward(self, x, mask=None, trace=None):
        B, T, D = x.shape
        q, k, v = self.qkv(self.ln1(x)).split(D, -1)
        sh = lambda t: t.reshape(B, T, self.nh, self.hd).transpose(1, 2)  # noqa: E731
        q, k, v = sh(q), sh(k), sh(v)
        s = q @ k.transpose(-1, -2) / math.sqrt(self.hd)
        if mask is not None:
            s = s.masked_fill(~mask, float("-inf"))
        a = s.softmax(-1)
        att = (a @ v).transpose(1, 2).reshape(B, T, D)
        x = x + self.proj(att)
        m = self.fc2(F.gelu(self.fc1(self.ln2(x)), approximate="tanh"))
        x = x + m
        if trace is not None:
            trace.update(attn=a, after_attn=x - m, out=x)
        return x


class ViT(nn.Module):
    D, P = 16, 2

    def __init__(self):
        super().__init__()
        self.embed = nn.Linear(self.P * self.P, self.D)
        self.cls = nn.Parameter(torch.zeros(1, 1, self.D))
        self.pos = nn.Parameter(torch.randn(1, 17, self.D) * 0.1)
        self.block = Block(self.D, 2, 32)
        self.ln = nn.LayerNorm(self.D)
        self.head = nn.Linear(self.D, 10)

    @staticmethod
    def patches(x):  # (B, 8, 8) -> (B, 16, 4), row-major patches
        B = len(x)
        return x.reshape(B, 4, 2, 4, 2).permute(0, 1, 3, 2, 4).reshape(B, 16, 4)

    def forward(self, x, trace=None):
        x = x.reshape(len(x), 8, 8)
        p = self.patches(x)
        tok = torch.cat([self.cls.expand(len(x), -1, -1), self.embed(p)], 1) + self.pos
        bt = {}
        h = self.block(tok, trace=bt)
        o = self.head(self.ln(h[:, 0]))
        if trace is not None:
            trace.update(input=x, patches=p, tokens=tok, attn=bt["attn"], out=h, logits=o)
        return o


# The toy VLM's vocabulary and captions
VOCAB = ["<bos>", "<eos>", "this", "is", "a", "an", ",", "it", "even", "odd"] + NAMES


def caption(digit: int) -> list[int]:
    art = "an" if NAMES[digit] == "eight" else "a"  # by sound: "an eight", but "a one"
    words = ["<bos>", "this", "is", art, NAMES[digit], ",", "it", "is", "even" if digit % 2 == 0 else "odd", "<eos>"]
    return [VOCAB.index(w) for w in words]


class VLM(nn.Module):
    Dv, Dt = 16, 24

    def __init__(self):
        super().__init__()
        self.v_embed = nn.Linear(4, self.Dv)
        self.v_pos = nn.Parameter(torch.randn(1, 16, self.Dv) * 0.1)
        self.v_block = Block(self.Dv, 2, 32)
        self.connector = nn.Linear(self.Dv, self.Dt)          # vision features -> the language model's width
        self.t_embed = nn.Embedding(len(VOCAB), self.Dt)
        self.t_pos = nn.Parameter(torch.randn(1, 16 + 10, self.Dt) * 0.1)
        self.t_block = Block(self.Dt, 2, 48)
        self.ln = nn.LayerNorm(self.Dt)
        self.lm_head = nn.Linear(self.Dt, len(VOCAB))

    def forward(self, x, ids, trace=None):
        x = x.reshape(len(x), 8, 8)
        vt = {}
        v = self.v_block(self.v_embed(ViT.patches(x)) + self.v_pos, trace=vt)
        img = self.connector(v)
        T = ids.shape[1]
        seq = torch.cat([img, self.t_embed(ids)], 1) + self.t_pos[:, :16 + T]
        L = 16 + T
        mask = torch.ones(L, L, dtype=torch.bool).tril()
        mask[:16, :16] = True                                  # image tokens see each other; text looks back only
        tt = {}
        h = self.t_block(seq, mask=mask, trace=tt)
        logits = self.lm_head(self.ln(h[:, 16:]))
        if trace is not None:
            trace.update(input=x, v_attn=vt["attn"], img=img, t_attn=tt["attn"], logits=logits)
        return logits


# ------------------------------------------------------------------------------------------ train
def train_cls(model, epochs, lr=3e-3):
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    for ep in range(epochs):
        model.train()
        idx = tr[torch.randperm(len(tr))]
        for i in range(0, len(idx), 64):
            b = idx[i:i + 64]
            loss = F.cross_entropy(model(X[b]), Y[b])
            opt.zero_grad(); loss.backward(); opt.step()
    model.eval()
    with torch.no_grad():
        return float((model(X[te]).argmax(-1) == Y[te]).float().mean())


def train_vlm(model, epochs=160, lr=3e-3):
    caps = torch.tensor([caption(int(y)) for y in Y])
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
    for ep in range(epochs):
        model.train()
        idx = tr[torch.randperm(len(tr))]
        for i in range(0, len(idx), 64):
            b = idx[i:i + 64]
            logits = model(X[b], caps[b, :-1])
            loss = F.cross_entropy(logits.reshape(-1, len(VOCAB)), caps[b, 1:].reshape(-1))
            opt.zero_grad(); loss.backward(); opt.step()
    model.eval()
    ok = 0
    with torch.no_grad():
        for j in te.tolist():
            ids = [0]
            for _ in range(9):
                nxt = int(model(X[j:j + 1], torch.tensor([ids]))[0, -1].argmax())
                ids.append(nxt)
                if nxt == 1:
                    break
            ok += ids == caption(int(Y[j]))
    return ok / len(te)


# ------------------------------------------------------------------------------------------ export
def tensors(model) -> dict:
    return {k: {"shape": list(v.shape), "data": [round(float(x), 5) for x in v.detach().reshape(-1)]} for k, v in model.state_dict().items()}


def flat(t: torch.Tensor):
    return [round(float(x), 5) for x in t.detach().reshape(-1)]


SAMPLES = te[:48].tolist()
REF_IDS = SAMPLES[:3]

specs = [
    ("mlp", MLP(), 120, "Multilayer perceptron", "Every pixel connects to every neuron. The simplest neural network."),
    ("cnn", CNN(), 60, "Convolutional network", "Small 3x3 filters slide over the image looking for strokes and corners, then pool."),
    ("rnn", RNN(), 80, "Recurrent network (GRU)", "Reads the image one row at a time and carries a memory from row to row."),
    ("vit", ViT(), 160, "Vision transformer", "Cuts the image into 2x2 patches; every patch looks at every other patch through attention."),
]
summary = []
for name, model, ep, title, blurb in specs:
    acc = train_cls(model, ep)
    ref = []
    with torch.no_grad():
        for j in REF_IDS:
            trc = {}
            model(X[j:j + 1], trace=trc)
            ref.append({"index": j, **{k: flat(v[0]) for k, v in trc.items()}})
    params = sum(p.numel() for p in model.parameters())
    flops = None
    pack = {"name": name, "title": title, "blurb": blurb, "accuracy": round(acc, 4), "params": params, "weights": tensors(model), "reference": ref}
    (OUT / f"{name}.json").write_text(json.dumps(pack, separators=(",", ":")), encoding="utf-8")
    summary.append((name, acc, params))
    print(f"{name}: test accuracy {acc:.3f}, {params} parameters")

vlm = VLM()
acc = train_vlm(vlm)
ref = []
with torch.no_grad():
    for j in REF_IDS:
        ids = torch.tensor([caption(int(Y[j]))[:-1]])
        trc = {}
        vlm(X[j:j + 1], ids, trace=trc)
        ref.append({"index": j, "ids": ids[0].tolist(), **{k: flat(v[0]) for k, v in trc.items()}})
params = sum(p.numel() for p in vlm.parameters())
pack = {"name": "vlm", "title": "Vision-language model", "blurb": "A vision tower turns the image into tokens; a small language model reads them and writes a sentence.",
        "accuracy": round(acc, 4), "accuracy_note": "whole caption exactly right", "params": params, "vocab": VOCAB, "weights": tensors(vlm), "reference": ref}
(OUT / "vlm.json").write_text(json.dumps(pack, separators=(",", ":")), encoding="utf-8")
print(f"vlm: exact captions {acc:.3f}, {params} parameters")

(OUT / "digits.json").write_text(json.dumps({"images": [flat(X[j]) for j in SAMPLES], "labels": [int(Y[j]) for j in SAMPLES],
                                             "note": "scikit-learn 8x8 digits (UCI), held-out test images, scaled to 0..1"}, separators=(",", ":")), encoding="utf-8")
print("wrote", OUT)
