"""ComfyUI auto-detection (`comfyfed_agent.detect`).

A fake ComfyUI (stdlib HTTP server on an ephemeral loopback port) answers
`/system_stats` and `/internal/folder_paths` with the same shapes the real
0.3x server produces, folder paths pointing into a pytest tmp tree so the
existence checks exercise real directories.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest

from comfyfed_agent import detect
from comfyfed_agent.config import AgentConfig


class _FakeComfyHandler(BaseHTTPRequestHandler):
    system_stats: dict = {"system": {"comfyui_version": "0.34.5", "os": "test"}}
    folder_paths: dict = {}

    def do_GET(self):  # noqa: N802 (stdlib naming)
        if self.path == "/system_stats":
            body = json.dumps(self.system_stats).encode()
        elif self.path == "/internal/folder_paths":
            body = json.dumps(self.folder_paths).encode()
        else:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):  # quiet
        pass


@pytest.fixture()
def fake_comfy(tmp_path):
    """(url, port, tree) -- a fake ComfyUI with a realistic folder layout."""
    shared_models = tmp_path / "Shared" / "models"
    install_base = tmp_path / "Install" / "ComfyUI"
    for d in (
        shared_models / "checkpoints",
        # A stale output/input pair next to the shared library (real desktop
        # installs have this) -- the `<output>/<category>` marker below must
        # win over this sibling-existence decoy.
        shared_models.parent / "output",
        shared_models.parent / "input",
        install_base / "models" / "checkpoints",
        install_base / "output" / "checkpoints",
        install_base / "input",
    ):
        d.mkdir(parents=True)

    handler = type(
        "Handler",
        (_FakeComfyHandler,),
        {
            "folder_paths": {
                "checkpoints": [
                    str(shared_models / "checkpoints"),
                    str(install_base / "models" / "checkpoints"),
                    str(install_base / "output" / "checkpoints"),
                ],
                "vae": [str(install_base / "models" / "vae")],
            }
        },
    )
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]
    try:
        yield f"http://127.0.0.1:{port}", port, {
            "models_dir": str(shared_models),
            "output": str(install_base / "output"),
            "input": str(install_base / "input"),
        }
    finally:
        server.shutdown()
        thread.join(timeout=5)


def test_probe_accepts_real_comfy_and_rejects_other_servers(fake_comfy):
    url, _port, _tree = fake_comfy
    with httpx.Client() as client:
        assert detect.probe_comfy(url, client) is True
        # A server that answers 200 without the fingerprint is not ComfyUI.
        handler = type("H", (_FakeComfyHandler,), {"system_stats": {"hello": "world"}})
        other = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        t = threading.Thread(target=other.serve_forever, daemon=True)
        t.start()
        try:
            assert detect.probe_comfy(f"http://127.0.0.1:{other.server_address[1]}", client) is False
        finally:
            other.shutdown()
            t.join(timeout=5)
        # Nothing listening at all.
        assert detect.probe_comfy("http://127.0.0.1:1", client) is False


def test_find_comfy_url_via_candidates_and_via_sweep(fake_comfy):
    url, port, _tree = fake_comfy
    with httpx.Client() as client:
        # Candidate hit.
        assert detect.find_comfy_url(client, candidates=(port,), sweep=()) == url
        # Sweep hit (candidates all dead; sweep includes the live port).
        assert (
            detect.find_comfy_url(client, candidates=(1,), sweep=(2, 3, port)) == url
        )
        # Nothing anywhere.
        assert detect.find_comfy_url(client, candidates=(1,), sweep=(2,)) is None


def test_detect_dirs_derives_models_output_input(fake_comfy):
    url, _port, tree = fake_comfy
    with httpx.Client() as client:
        detected = detect.detect_dirs(url, client)
    assert detected["models_dir"] == tree["models_dir"]
    assert detected["comfy_output_dir"] == tree["output"]
    assert detected["comfy_input_dir"] == tree["input"]


def test_detect_dirs_tolerates_missing_endpoint():
    handler = type("H", (_FakeComfyHandler,), {})

    class NoFolderPaths(handler):
        def do_GET(self):  # noqa: N802
            if self.path == "/internal/folder_paths":
                self.send_response(404)
                self.end_headers()
                return
            super().do_GET()

    server = ThreadingHTTPServer(("127.0.0.1", 0), NoFolderPaths)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    try:
        with httpx.Client() as client:
            assert detect.detect_dirs(f"http://127.0.0.1:{server.server_address[1]}", client) == {}
    finally:
        server.shutdown()
        t.join(timeout=5)


def test_apply_detection_fills_only_missing_fields(fake_comfy, monkeypatch):
    url, port, tree = fake_comfy
    monkeypatch.setattr(detect, "DEFAULT_PORT_CANDIDATES", (port,))
    monkeypatch.setattr(detect, "SWEEP_PORTS", ())

    cfg = AgentConfig()
    with httpx.Client() as client:
        notes = detect.apply_detection(cfg, client, AgentConfig.comfy_url)
    assert cfg.comfy_url == url
    assert cfg.models_dir == tree["models_dir"]
    assert cfg.comfy_output_dir == tree["output"]
    assert cfg.comfy_input_dir == tree["input"]
    assert len(notes) == 4


def test_apply_detection_never_touches_user_set_values(fake_comfy):
    url, _port, tree = fake_comfy
    cfg = AgentConfig(
        comfy_url=url,  # points at the live fake -- probe succeeds directly
        models_dir="D:/my/models",
    )
    with httpx.Client() as client:
        notes = detect.apply_detection(cfg, client, AgentConfig.comfy_url)
    # models_dir was user-set: untouched; the two unset dirs get filled.
    assert cfg.models_dir == "D:/my/models"
    assert cfg.comfy_output_dir == tree["output"]
    assert all("models_dir" not in n for n in notes)


def test_apply_detection_leaves_hand_set_unreachable_url_alone(fake_comfy):
    _url, port, _tree = fake_comfy
    cfg = AgentConfig(comfy_url="http://127.0.0.1:1")  # hand-set, dead
    with httpx.Client() as client:
        notes = detect.apply_detection(cfg, client, AgentConfig.comfy_url)
    assert cfg.comfy_url == "http://127.0.0.1:1"
    assert notes == []


def test_apply_detection_no_comfy_found_is_a_quiet_noop(monkeypatch):
    monkeypatch.setattr(detect, "DEFAULT_PORT_CANDIDATES", (1,))
    monkeypatch.setattr(detect, "SWEEP_PORTS", ())
    cfg = AgentConfig()
    with httpx.Client() as client:
        notes = detect.apply_detection(cfg, client, AgentConfig.comfy_url)
    assert notes == []
    assert cfg.models_dir is None
