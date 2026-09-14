"""Tests for the one-line installer endpoints and packaged installer scripts.

See the "一行安裝指令 addendum" section of
`docs/superpowers/specs/2026-09-12-comfyfed-spec.md`.

These tests exercise the FastAPI routes and do STATIC sanity checks on the
installer scripts themselves (placeholders present, `set -euo pipefail` in
the bash script, PowerShell parses cleanly, LF-only line endings). They
deliberately never execute install.ps1/install.sh/install.cmd.
"""

from __future__ import annotations

import os
import shutil
import subprocess

import pytest
from fastapi.testclient import TestClient

from comfyfed_server import app as app_module
from comfyfed_server import bootstrap, installer_routes, security


@pytest.fixture()
def client_with_url(tmp_path):
    data_dir = str(tmp_path / "with-url")
    bootstrap.ensure_installed(data_dir, lang="en", url="https://console.example.com", interactive=False)
    app = app_module.create_app(data_dir)
    c = TestClient(app)
    c.data_dir = data_dir
    return c


@pytest.fixture()
def client_no_url(tmp_path):
    data_dir = str(tmp_path / "no-url")
    bootstrap.ensure_installed(data_dir, lang="en", url=None, interactive=False)
    app = app_module.create_app(data_dir)
    c = TestClient(app)
    c.data_dir = data_dir
    return c


# ---------------------------------------------------------------------------
# GET /install.ps1 | /install.sh | /install.cmd
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("path", ["/install.ps1", "/install.sh", "/install.cmd"])
def test_installer_scripts_serve_with_content_type(client_with_url, path):
    r = client_with_url.get(path)
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/plain")


@pytest.mark.parametrize("path", ["/install.ps1", "/install.sh"])
def test_installer_scripts_substitute_platform_url_and_token(client_with_url, path):
    r = client_with_url.get(path, params={"token": "tok_abc123"})
    body = r.text
    assert "{{PLATFORM_URL}}" not in body
    assert "{{REGISTER_TOKEN}}" not in body
    assert "https://console.example.com" in body
    assert "tok_abc123" in body


def test_ps1_defaults_token_to_empty_string(client_with_url):
    body = client_with_url.get("/install.ps1").text
    assert "{{REGISTER_TOKEN}}" not in body
    # The literal placeholder is replaced by an empty string, not dropped
    # entirely -- so the surrounding quoting in the script stays intact.
    assert "$RegisterToken = ''" in body


def test_sh_defaults_token_to_empty_string(client_with_url):
    body = client_with_url.get("/install.sh").text
    assert "{{REGISTER_TOKEN}}" not in body
    assert "REGISTER_TOKEN=''" in body


def test_installer_scripts_fall_back_to_request_base_url_when_unset(client_no_url):
    r = client_no_url.get("/install.ps1")
    body = r.text
    assert "{{PLATFORM_URL}}" not in body
    # TestClient's default base URL.
    assert "http://testserver" in body


def test_install_cmd_omits_query_when_token_absent(client_with_url):
    r = client_with_url.get("/install.cmd")
    assert "{{TOKEN_QUERY}}" not in r.text
    assert "install.ps1' | iex" in r.text
    assert "token=" not in r.text


def test_install_cmd_includes_token_query_when_present(client_with_url):
    r = client_with_url.get("/install.cmd", params={"token": "tok_xyz"})
    assert "{{TOKEN_QUERY}}" not in r.text
    assert "install.ps1?token=tok_xyz' | iex" in r.text


# ---------------------------------------------------------------------------
# GET /api/platform
# ---------------------------------------------------------------------------


def test_api_platform_shape_matches_bundle_pubkey(client_with_url):
    r = client_with_url.get("/api/platform")
    assert r.status_code == 200
    body = r.json()
    assert set(body.keys()) == {"platform_url", "platform_pubkey"}
    assert body["platform_url"] == "https://console.example.com"

    _, verify_key = security.load_platform_keys(client_with_url.data_dir)
    assert body["platform_pubkey"] == bytes(verify_key).hex()


def test_api_platform_falls_back_to_request_base_url(client_no_url):
    r = client_no_url.get("/api/platform")
    body = r.json()
    assert body["platform_url"] == "http://testserver"


# ---------------------------------------------------------------------------
# Package-data resolution (installed-layout accessor)
# ---------------------------------------------------------------------------


def test_installers_dir_resolves_and_contains_all_three_scripts():
    d = installer_routes.installers_dir()
    assert os.path.isdir(d)
    for name in ("install.ps1", "install.sh", "install.cmd"):
        assert os.path.isfile(os.path.join(d, name)), name


# ---------------------------------------------------------------------------
# Static sanity checks on the script sources themselves
# ---------------------------------------------------------------------------


def _source_path(filename: str) -> str:
    return os.path.join(installer_routes.installers_dir(), filename)


def test_ps1_source_has_placeholders():
    text = open(_source_path("install.ps1"), encoding="utf-8").read()
    assert "{{PLATFORM_URL}}" in text
    assert "{{REGISTER_TOKEN}}" in text


def test_sh_source_has_placeholders_and_strict_mode():
    text = open(_source_path("install.sh"), encoding="utf-8").read()
    assert "{{PLATFORM_URL}}" in text
    assert "{{REGISTER_TOKEN}}" in text
    assert "set -euo pipefail" in text


def test_cmd_source_has_placeholders():
    text = open(_source_path("install.cmd"), encoding="utf-8").read()
    assert "{{PLATFORM_URL}}" in text
    assert "{{TOKEN_QUERY}}" in text


def test_sh_stored_with_lf_only_no_crlf():
    raw = open(_source_path("install.sh"), "rb").read()
    assert b"\r\n" not in raw


def test_ps1_stored_with_lf_only_no_crlf():
    raw = open(_source_path("install.ps1"), "rb").read()
    assert b"\r\n" not in raw


def test_sh_syntax_check_via_bash_n():
    """`bash -n install.sh` -- syntax check only, never executes the script."""
    bash = shutil.which("bash")
    if bash is None:
        pytest.skip("bash not available in this environment")
    result = subprocess.run(
        [bash, "-n", _source_path("install.sh")],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr


def test_ps1_parses_via_powershell_tokenizer():
    """PowerShell parse check -- tokenizes the script, never executes it."""
    powershell = shutil.which("powershell") or shutil.which("pwsh")
    if powershell is None:
        pytest.skip("powershell not available in this environment")
    script_path = _source_path("install.ps1")
    ps_command = (
        "$ErrorActionPreference='Stop'; "
        f"$null = [System.Management.Automation.PSParser]::Tokenize("
        f"(Get-Content -Raw '{script_path}'), [ref]$null)"
    )
    result = subprocess.run(
        [powershell, "-NoProfile", "-Command", ps_command],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
