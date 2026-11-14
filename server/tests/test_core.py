"""Unit tests that need no network and no model download. Run from server/: .venv/Scripts/python -m pytest tests"""
import pytest

from app import hub, hw
from app.adapters import _is_buffer, _stacks, _tinfo, build_graph


def T(shape, dtype="BF16"):
    return {"shape": shape, "dtype": dtype}


def test_parse_repo_accepts_urls_and_short_names():
    assert hub.parse_repo("https://huggingface.co/HuggingFaceTB/SmolLM2-135M/tree/main") == "HuggingFaceTB/SmolLM2-135M"
    assert hub.parse_repo("gpt2") == "openai-community/gpt2"
    for bad in ("not a repo !!", "org/na me", "../../etc", "org/<script>"):
        with pytest.raises(hub.HubError):
            hub.parse_repo(bad)


def test_causal_mask_buffers_are_not_parameters():
    assert _is_buffer("transformer.h.0.attn.bias", [1, 1, 1024, 1024])
    assert not _is_buffer("transformer.h.0.attn.c_attn.bias", [2304])


def test_vlm_towers_become_separate_stacks():
    header = {}
    for i in range(3):
        header[f"model.text_model.layers.{i}.self_attn.q_proj.weight"] = T([64, 64])
        header[f"model.text_model.layers.{i}.mlp.up_proj.weight"] = T([128, 64])
    for i in range(2):
        header[f"model.vision_model.encoder.layers.{i}.self_attn.q_proj.weight"] = T([32, 32])
    header["model.connector.modality_projection.proj.weight"] = T([64, 32])
    header["model.text_model.embed_tokens.weight"] = T([100, 64])
    g = build_graph("x/y", {"model_type": "idefics3"}, header, {"safetensors": ["model.safetensors"]})
    roles = [(s["role"], s["count"]) for s in g["stacks"]]
    assert roles == [("text", 3), ("vision", 2)]
    assert len(g["blocks"]) == 3              # the main view is the language model
    assert g["connector"]["params"] == 64 * 32


def test_single_stack_models_are_unchanged():
    header = {f"model.layers.{i}.self_attn.q_proj.weight": T([8, 8]) for i in range(4)}
    st = _stacks({n: _tinfo(n, e) for n, e in header.items()})
    assert len(st) == 1 and len(st[0]["blocks"]) == 4


def test_pcie_bandwidth_from_generation_and_lanes():
    l = hw._pcie({"Name": "nvme", "Gen": 4, "Width": 4})
    assert l["gbps"] == pytest.approx(16 * 128 / 130 * 4 / 8, rel=1e-3)   # ~7.88 GB/s
    assert hw._pcie({"Gen": 3, "Width": 2})["gbps"] == pytest.approx(8 * 128 / 130 * 2 / 8, rel=1e-3)


def test_spread_reports_min_median_max_and_variation():
    s = hw._spread([10, 12, 11, 13, 9])
    assert (s["min"], s["median"], s["max"], s["n"]) == (9, 11, 13, 5)
    assert 0 < s["cv_pct"] < 20


def test_energy_summary_attributes_each_interval_to_its_starting_sample():
    rec = hw.PowerRecorder.__new__(hw.PowerRecorder)
    rec.samples = [
        {"t": 0.0, "stage": "idle", "pkg_w": 8.0, "core_w": [1.0, 1.0]},
        {"t": 0.1, "stage": "idle", "pkg_w": 9.0, "core_w": [1.0, 1.0]},
        {"t": 0.2, "stage": "busy", "pkg_w": 60.0, "core_w": [25.0, 25.0]},
        {"t": 0.3, "stage": "busy", "pkg_w": 62.0, "core_w": [26.0, 26.0]},
        {"t": 0.4, "stage": "cool", "pkg_w": 10.0, "core_w": [1.0, 1.0]},
    ]
    S = rec.summary()
    assert S["busy"]["joules"] == pytest.approx((60 + 62) * 0.1)
    assert S["busy"]["core_j"] == pytest.approx([5.1, 5.1])
    for v in S.values():
        assert v["avg_w"] <= v["peak_w"] + 1e-9
