"""`comfyfed-server fetch-comfy-ui` internals: pin, zip-slip guard, no-op.

No network: the wheel is a zip, so these build tiny ones in memory and check
what `comfy_frontend` does with them. The pinned version/hash pair itself is
exercised for real by whoever runs the CLI -- what is asserted here is that a
mismatching digest is refused and that `--version` is the only way to bypass
that.
"""

from __future__ import annotations

import hashlib
import os
import zipfile
from io import BytesIO

import pytest

from comfyfed_server import comfy_frontend


def _wheel(members: dict) -> bytes:
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, content in members.items():
            archive.writestr(name, content)
    return buffer.getvalue()


_GOOD = {
    "comfyui_frontend_package/static/index.html": "<!doctype html><title>ComfyUI</title>",
    "comfyui_frontend_package/static/assets/app.js": "export const a = 1;",
    "comfyui_frontend_package-9.9.9.dist-info/METADATA": "Name: comfyui-frontend-package",
}


def test_extract_takes_only_the_static_tree(tmp_path):
    dest = str(tmp_path / "comfy_frontend")
    assert comfy_frontend.extract_static(_wheel(_GOOD), dest) == 2

    assert os.path.isfile(os.path.join(dest, "index.html"))
    assert os.path.isfile(os.path.join(dest, "assets", "app.js"))
    # dist-info is metadata, not part of the served bundle.
    assert not os.path.exists(os.path.join(dest, "METADATA"))
    assert comfy_frontend.is_populated(str(tmp_path))


def test_extract_refuses_a_traversing_member(tmp_path):
    dest = str(tmp_path / "data" / "comfy_frontend")
    evil = dict(_GOOD)
    evil["comfyui_frontend_package/static/../../../escaped.txt"] = "pwned"

    with pytest.raises(comfy_frontend.FetchError, match="outside"):
        comfy_frontend.extract_static(_wheel(evil), dest)

    assert not os.path.exists(str(tmp_path / "escaped.txt"))


def test_extract_rejects_a_wheel_with_no_static_tree(tmp_path):
    with pytest.raises(comfy_frontend.FetchError, match="no .* files"):
        comfy_frontend.extract_static(_wheel({"other/thing.txt": "x"}), str(tmp_path / "out"))


def test_fetch_is_a_no_op_when_already_populated(tmp_path, monkeypatch):
    data_dir = str(tmp_path)
    os.makedirs(comfy_frontend.frontend_dir(data_dir))
    with open(os.path.join(comfy_frontend.frontend_dir(data_dir), "index.html"), "w") as f:
        f.write("<html></html>")

    def _explode(*_args, **_kwargs):
        raise AssertionError("fetch must not touch the network when already populated")

    monkeypatch.setattr(comfy_frontend, "wheel_url", _explode)
    monkeypatch.setattr(comfy_frontend, "download", _explode)

    assert comfy_frontend.fetch(data_dir)["status"] == "already_present"


def test_fetch_verifies_the_pinned_hash(tmp_path, monkeypatch):
    payload = _wheel(_GOOD)
    monkeypatch.setattr(comfy_frontend, "wheel_url", lambda version: "http://example/x.whl")
    monkeypatch.setattr(comfy_frontend, "download", lambda url: payload)

    with pytest.raises(comfy_frontend.FetchError, match="sha256 mismatch"):
        comfy_frontend.fetch(str(tmp_path))

    # ...and the pin is what is compared against, so a matching digest passes.
    monkeypatch.setattr(comfy_frontend, "FRONTEND_SHA256", hashlib.sha256(payload).hexdigest())
    result = comfy_frontend.fetch(str(tmp_path))
    assert result == {
        "status": "installed",
        "version": comfy_frontend.FRONTEND_VERSION,
        "dir": comfy_frontend.frontend_dir(str(tmp_path)),
        "files": 2,
        "verified": True,
    }


def test_explicit_version_skips_hash_verification(tmp_path, monkeypatch):
    """`--version` overrides the pin, and the pinned digest cannot describe
    a build we never recorded -- so it is deliberately not checked."""
    payload = _wheel(_GOOD)
    seen = {}

    def _url(version):
        seen["version"] = version
        return "http://example/x.whl"

    monkeypatch.setattr(comfy_frontend, "wheel_url", _url)
    monkeypatch.setattr(comfy_frontend, "download", lambda url: payload)

    result = comfy_frontend.fetch(str(tmp_path), version="1.0.0-not-pinned")
    assert seen["version"] == "1.0.0-not-pinned"
    assert result["verified"] is False
    assert result["status"] == "installed"
