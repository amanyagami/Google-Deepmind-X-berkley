"""S9 tests: origin/host/pairing hardening, per-component bench, hub header rules, SSRF. No real hardware benches, no network."""
import json
import os
import threading
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import bench, hub, hw, netfetch, security, state
from app.main import app

LOCAL = {"host": "localhost:8000", "origin": "http://localhost:8000"}
EVIL = {"origin": "https://evil.example", "host": "localhost:8000"}


@pytest.fixture()
def client():
    state.release()
    with TestClient(app, base_url="http://localhost:8000") as c:
        yield c
    state.release()


def _ws_code(c, path, headers=None, protocols=None):
    with pytest.raises(WebSocketDisconnect) as e:
        with c.websocket_connect(path, headers=headers or {}, subprotocols=protocols or []) as ws:
            ws.receive_json()
    return e.value.code


def test_http_cross_origin_refused_and_no_cors(client):
    r = client.get("/api/health", headers=EVIL)
    assert r.status_code == 403 and "access-control-allow-origin" not in r.headers
    assert client.get("/api/health", headers={"origin": "null"}).status_code == 403


def test_wrong_host_refused(client):
    assert client.get("/api/health", headers={"host": "evil.example"}).status_code == 403
    assert client.get("/api/health", headers={"host": "127.0.0.1.evil.example:8000"}).status_code == 403


def test_preflight_foreign_gets_no_cors_or_pna(client):
    h = {**EVIL, "access-control-request-method": "GET", "access-control-request-private-network": "true"}
    r = client.options("/api/health", headers=h)
    assert r.status_code == 403
    assert not [k for k in r.headers if k.lower().startswith("access-control")]
    ok = client.options("/api/health", headers={**h, "origin": "http://localhost:8000"})
    assert ok.headers["access-control-allow-origin"] == "http://localhost:8000"
    assert ok.headers["access-control-allow-private-network"] == "true"


def test_env_origin_needs_pairing_and_echoes_origin(client, monkeypatch):
    monkeypatch.setenv("NEURAL_STUDIO_ORIGINS", "https://app.example")
    h = {"origin": "https://app.example"}
    r = client.get("/api/probe?repo=..%2Fx", headers=h)
    assert r.status_code == 401 and r.headers["access-control-allow-origin"] == "https://app.example"
    assert client.get("/api/probe?repo=..%2Fx", headers={**h, "x-ns-pair": "wrong"}).status_code == 401
    r = client.get("/api/probe?repo=..%2Fx", headers={**h, "x-ns-pair": security.PAIR})
    assert r.status_code == 400 and r.headers["access-control-allow-origin"] == "https://app.example"


def test_same_origin_page_needs_no_pairing_but_bare_client_does(client):
    assert client.get("/api/probe?repo=..%2Fx", headers={"origin": "http://localhost:8000"}).status_code != 401
    assert client.get("/api/probe?repo=..%2Fx", headers={"sec-fetch-site": "same-origin"}).status_code != 401
    assert client.get("/api/probe?repo=..%2Fx").status_code == 401
    assert client.get("/api/probe?repo=..%2Fx", headers={"x-ns-pair": security.PAIR}).status_code != 401


def test_token_env_still_works(client, monkeypatch):
    monkeypatch.setattr(security, "_TOKEN", "s3cret")
    assert client.get("/api/probe?repo=..%2Fx", headers={"sec-fetch-site": "same-origin"}).status_code == 401
    assert client.get("/api/probe?repo=..%2Fx", headers={"x-studio-token": "s3cret"}).status_code != 401
    assert client.get("/api/probe?repo=..%2Fx&token=s3cret").status_code == 401


def test_ws_cross_origin_wrong_host_and_pairing(client, monkeypatch):
    assert _ws_code(client, "/ws/bench", EVIL) == 4403
    assert _ws_code(client, "/ws/telemetry", {"host": "evil.example"}) == 4403
    monkeypatch.setenv("NEURAL_STUDIO_ORIGINS", "https://app.example")
    assert _ws_code(client, "/ws/bench", {"origin": "https://app.example", "host": "localhost:8000"}, ["ns-v1", "ns-pair.nope"]) == 4401
    monkeypatch.setattr("app.hw.bench_run", lambda emit, client, plan, cancel: emit({"type": "result", "name": "net", "data": None}))
    h = {"origin": "https://app.example", "host": "localhost:8000"}
    with client.websocket_connect("/ws/bench", headers=h, subprotocols=["ns-v1", "ns-pair." + security.PAIR]) as ws:
        ws.send_json({"type": "start", "only": ["net"]})
        assert ws.receive_json()["type"] == "result"
    with client.websocket_connect("/ws/bench", headers=h) as ws:      # pairing in the first message
        ws.send_json({"type": "start", "only": ["net"], "pair": security.PAIR})
        assert ws.receive_json()["type"] == "result"


def test_bench_validation():
    bad_list = [{"only": ["rm -rf"]}, {"only": []}, {"only": "net"}, {"only": ["net"], "params": {"path": "/etc/passwd"}},
                {"params": {"url": "https://x"}}, {"params": {"seconds": 31}}, {"params": {"seconds": "5"}}, {"params": {"n": True}},
                {"params": {"n": 64}}, {"params": {"ram_mb": 10**9}}, {"params": {"disk_mb": 10**9}}, {"params": {"seconds": float("nan")}},
                {"baseline": "yes"}]
    for bad in bad_list:
        with pytest.raises(bench.BadRequest):
            bench.validate_start({"type": "start", **bad})
    p = bench.validate_start({"type": "start", "only": ["dram", "matmul_1"], "params": {"seconds": 2, "n": 256}})
    assert p.only == ["matmul_1", "dram"] and p.params == {"seconds": 2.0, "n": 256}


def test_ws_invalid_only_gets_bad_request(client):
    with client.websocket_connect("/ws/bench", headers=LOCAL) as ws:
        ws.send_json({"type": "start", "only": ["evil"]})
        m = ws.receive_json()
        assert m["type"] == "error" and m["code"] == "bad_request"


def _slow_bench(monkeypatch, stopped):
    def fake(emit, client, plan, cancel):
        emit({"type": "stage", "name": "x"})
        t0 = time.monotonic()
        while not cancel.is_set() and time.monotonic() - t0 < 20:
            time.sleep(0.01)
        stopped.set()
        raise hw.Cancelled()
    monkeypatch.setattr("app.hw.bench_run", fake)


def test_second_bench_busy_fast_and_run_409(client, monkeypatch):
    stopped = threading.Event()
    _slow_bench(monkeypatch, stopped)
    with client.websocket_connect("/ws/bench", headers=LOCAL) as a:
        a.send_json({"type": "start", "only": ["net"]})
        assert a.receive_json()["type"] == "stage"
        t = time.monotonic()
        with client.websocket_connect("/ws/bench", headers=LOCAL) as b:
            b.send_json({"type": "start", "only": ["net"]})
            m = b.receive_json()
        assert m["type"] == "error" and m["code"] == "busy" and time.monotonic() - t < 1.5
        r = client.post("/api/run", json={"repo": "gpt2", "prompt": "hi"}, headers={"x-ns-pair": security.PAIR})
        assert r.status_code == 409 and r.json()["code"] == "busy"
        a.send_json({"type": "cancel"})
        m = a.receive_json()
        assert m["type"] == "done" and m["cancelled"] is True


def test_disconnect_stops_worker_within_a_second(client, monkeypatch):
    stopped = threading.Event()
    _slow_bench(monkeypatch, stopped)
    with client.websocket_connect("/ws/bench", headers=LOCAL) as a:
        a.send_json({"type": "start", "only": ["net"]})
        assert a.receive_json()["type"] == "stage"
    t = time.monotonic()
    assert stopped.wait(1.0)
    while state.busy() and time.monotonic() - t < 1.0:
        time.sleep(0.01)
    assert not state.busy()


def test_client_tasks_are_per_id():
    out = []
    ct = bench.ClientTasks(out.append)
    res = {}

    def ask(name):
        res[name] = ct.request(name, timeout=5)
    ths = [threading.Thread(target=ask, args=(n,)) for n in ("gpu", "other")]
    for t in ths:
        t.start()
    while len(out) < 2:
        time.sleep(0.01)
    ids = {m["name"]: m["id"] for m in out}
    ct.deliver({"id": ids["other"], "name": "other", "data": 2})
    ct.deliver({"id": ids["gpu"], "name": "gpu", "data": 1})
    for t in ths:
        t.join(2)
    assert res == {"gpu": 1, "other": 2}


def test_temp_file_removed_after_cancel_mid_write():
    cancel = threading.Event()
    calls = []

    def cb(v, best):
        calls.append(v)
        if len(calls) == 2:
            cancel.set()
    with pytest.raises(hw.Cancelled):
        hw._disk_bench(64, cb, cancel)
    assert len(calls) >= 2 and os.listdir(hw.temp_dir()) == []


def test_sweep_removes_leftovers():
    p = os.path.join(hw.temp_dir(), "old.bin")
    with open(p, "wb") as f:
        f.write(b"x")
    assert hw.sweep_temp() >= 1 and not os.path.exists(p)


def test_symlinked_temp_dir_refused(tmp_path, monkeypatch):
    real = tmp_path / "real"
    real.mkdir()
    try:
        os.symlink(real, tmp_path / hw._TMP_NAME, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks not permitted here")
    monkeypatch.setattr(hw.tempfile, "gettempdir", lambda: str(tmp_path))
    with pytest.raises(RuntimeError):
        hw.temp_dir()


def test_stats_discard_warmup_and_ci():
    s = hw._stats([1000, 10, 11, 10, 12, 11, 10], discard=1)
    assert s["n"] == 6 and s["warmup_discarded"] == 1 and s["median"] == 10.5
    assert s["ci95"][0] <= s["median"] <= s["ci95"][1]


def test_process_object_is_cached():
    assert hw._proc() is hw._proc()


# ---- parse_header
def H(entries, extra=None):
    raw = json.dumps({**entries, **(extra or {})}).encode()
    return len(raw), raw


def ent(dtype="F32", shape=(2, 2), offs=(0, 16)):
    return {"dtype": dtype, "shape": list(shape), "data_offsets": list(offs)}


def test_parse_header_accepts_valid():
    n, raw = H({"a": ent(), "b": ent("BF16", (4,), (16, 24))}, {"__metadata__": {"format": "pt"}})
    out = hub.parse_header(n, raw, 8 + n + 24)
    assert out["b"]["shape"] == [4] and "__metadata__" not in out


BAD_HEADERS = [
    ("non-dict", {"a": 5}, None), ("missing", {"a": {"dtype": "F32", "shape": [1]}}, None),
    ("I16", {"a": ent("I16", (2,), (0, 4))}, None), ("U16", {"a": ent("U16", (2,), (0, 4))}, None),
    ("BOOL", {"a": ent("BOOL", (4,), (0, 4))}, None), ("F8", {"a": ent("F8_E4M3", (4,), (0, 4))}, None),
    ("9 dims", {"a": ent("U8", (1,) * 9, (0, 1))}, None), ("negative", {"a": ent("U8", (-1,), (0, 0))}, None),
    ("float dim", {"a": ent("U8", (1.5,), (0, 1))}, None), ("bool dim", {"a": ent("U8", (True,), (0, 1))}, None),
    ("outside", {"a": ent("U8", (8,), (0, 8))}, 8 + 60 + 4),
    ("overlap", {"a": ent("U8", (8,), (0, 8)), "b": ent("U8", (8,), (4, 12))}, None),
    ("size mismatch", {"a": ent("F32", (2, 2), (0, 12))}, None),
    ("huge", {"a": ent("U8", (2**40, 2**40), (0, 1))}, None),
    ("reversed", {"a": ent("U8", (1,), (5, 4))}, None),
]


@pytest.mark.parametrize("name,entries,size", BAD_HEADERS)
def test_parse_header_rejects(name, entries, size):
    n, raw = H(entries)
    with pytest.raises(hub.HubError):
        hub.parse_header(n, raw, size)


def test_parse_header_length_and_shape_of_header():
    for n in (0, hub.MAX_HEADER_BYTES + 1, -1):
        with pytest.raises(hub.HubError):
            hub.parse_header(n, b"{}")
    for raw in (b"[]", b"not json", b'"x"'):
        with pytest.raises(hub.HubError):
            hub.parse_header(len(raw), raw)


def test_weight_map_filenames():
    ok = {"a": "m-1.safetensors", "b": "m-1.safetensors", "c": "sub/m-2.safetensors"}
    assert hub.weight_map({"weight_map": ok}) == ["m-1.safetensors", "sub/m-2.safetensors"]
    for bad in ("../x.safetensors", "a//b.safetensors", "/etc/x.safetensors", "https://evil/x.safetensors", "a\\b.safetensors",
                "a/../b.safetensors", "%2e%2e/x.safetensors", "x.bin", "", 5, "a?b.safetensors"):
        with pytest.raises(hub.HubError):
            hub.weight_map({"weight_map": {"t": bad}})
    with pytest.raises(hub.HubError):
        hub.weight_map({"weight_map": []})


@pytest.mark.parametrize("bad", ["../x", "a/..", "a/b/c/d", "a b", "%2e%2e/x", "a/b?x#y", "", "   ", "a" * 200, "a/" + "b" * 200])
def test_parse_repo_rejects(bad):
    with pytest.raises(hub.HubError):
        hub.parse_repo(bad)


def test_parse_repo_url_forms_still_work():
    assert hub.parse_repo("https://huggingface.co/a/b?x#y") == "a/b"
    assert hub.parse_repo("huggingface.co/a/b/tree/main") == "a/b"


def test_probes_cache_is_bounded(monkeypatch):
    from app import main
    main._PROBES.clear()
    monkeypatch.setattr(main.hub, "list_files", lambda r, s: ["model.safetensors"])
    monkeypatch.setattr(main.hub, "get_json", lambda *a, **k: {})
    monkeypatch.setattr(main.hub, "read_all_headers", lambda *a: {})
    monkeypatch.setattr(main, "build_graph", lambda *a: {})
    for i in range(main._PROBES_MAX + 5):
        main.do_probe(f"o/m{i}")
    assert len(main._PROBES) == main._PROBES_MAX


def test_read_tensor_rows_bounded_strided_and_3d(monkeypatch):
    calls = []

    def fake(url, a, b, what, stats=None, info=None):
        calls.append((a, b))
        assert b - a + 1 <= hub.MAX_READ_BYTES
        return bytes(b - a + 1)
    monkeypatch.setattr(hub, "fetch_range", fake)
    st = hub.ReadStats()
    e = {"dtype": "F32", "shape": [100_000, 4096], "data_offsets": [0, 100_000 * 4096 * 4], "base": 100, "file": "m.safetensors"}
    arr, n = hub.read_tensor_rows("o/m", e, 1024, st)
    assert n <= hub.MAX_ROW_RANGES and arr.shape[0] == n and len(calls) == n
    assert max(a for a, _ in calls) > 50_000 * 4096 * 4            # strided across the tensor, not the first rows
    e3 = {**e, "shape": [4, 8, 8], "data_offsets": [0, 4 * 64 * 4]}
    with pytest.raises(hub.HubError):
        hub.read_tensor_rows("o/m", e3, 16, st)
    arr, n = hub.read_tensor_rows("o/m", e3, 16, st, i0=2)
    assert arr.shape == (8, 8)
    with pytest.raises(hub.HubError):
        hub.read_tensor_rows("o/m", e3, 16, st, i0=4)


def test_fetch_range_caps():
    with pytest.raises(hub.HubError):
        hub.fetch_range("https://huggingface.co/x", 0, hub.MAX_RANGE_BYTES, "x")


def test_bad_repo_is_4xx_not_500(client):
    assert client.get("/api/probe", params={"repo": "../x"}, headers={"x-ns-pair": security.PAIR}).status_code == 400


# ---- SSRF
def PUBLIC(host, port):
    return ["93.184.216.34"]


SSRF_URLS = [
    "http://example.com/x", "file:///etc/passwd", "ftp://example.com/x", "https://127.0.0.1/x", "https://localhost/x",
    "https://[::1]/x", "https://169.254.169.254/latest/meta-data", "https://10.0.0.1/x", "https://192.168.1.1/x",
    "https://0x7f.1/x", "https://2130706433/x", "https://user@127.0.0.1/x", "https://user:pw@example.com/x",
    "https://[::ffff:127.0.0.1]/x", "https://172.16.0.1/x", "https://example.com\\@127.0.0.1/", "", "https://",
]


@pytest.mark.parametrize("url", SSRF_URLS)
def test_ssrf_rejected(url):
    with pytest.raises(netfetch.UnsafeURL):
        netfetch.check_url(url, resolver=PUBLIC)


def test_ssrf_hostname_resolving_to_private_rejected():
    with pytest.raises(netfetch.UnsafeURL):
        netfetch.check_url("https://evil.example/x", resolver=lambda h, p: ["93.184.216.34", "10.0.0.5"])


def test_ssrf_redirect_to_private_rejected_and_good_path_works():
    def opener(ip, port, host, path, timeout, max_bytes, deadline):
        assert ip == "93.184.216.34"                      # pinned
        if host == "good.example":
            return 302, {"location": "https://10.0.0.1/admin"}, b""
        return 200, {}, b"ok"
    with pytest.raises(netfetch.UnsafeURL):
        netfetch.safe_fetch("https://good.example/a", resolver=PUBLIC, opener=opener)

    def rebind(h, p):
        return ["93.184.216.34"] if h == "good.example" else ["127.0.0.1"]
    with pytest.raises(netfetch.UnsafeURL):
        netfetch.safe_fetch("https://good.example/a", resolver=rebind, opener=lambda *a: (302, {"location": "https://rebind.example/"}, b""))
    assert netfetch.safe_fetch("https://fine.example/a", resolver=PUBLIC, opener=opener) == b"ok"


def test_ssrf_redirect_limit():
    with pytest.raises(netfetch.UnsafeURL):
        netfetch.safe_fetch("https://a.example/", resolver=PUBLIC, opener=lambda *a: (302, {"location": "https://a.example/"}, b""))
