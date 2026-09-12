"""SPA static mount: `/` serves web/dist, client-side routes fall back to
index.html, and /api/* 404s stay JSON (never swallowed by the SPA fallback)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from comfyfed_server import app as app_module
from comfyfed_server import bootstrap


@pytest.fixture()
def client(tmp_path):
    data_dir = str(tmp_path)
    result = bootstrap.ensure_installed(data_dir, lang="en", url="http://h", interactive=False)
    app = app_module.create_app(data_dir)
    c = TestClient(app)
    c.admin_password = result.admin_password
    return c


def test_root_serves_index_html(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "<html" in r.text.lower()


def test_client_side_route_falls_back_to_index_html(client):
    r = client.get("/jobs")
    assert r.status_code == 200
    assert "<html" in r.text.lower()


def test_unknown_api_route_stays_json_404(client):
    r = client.get("/api/does-not-exist")
    assert r.status_code == 404
    assert "error" in r.json()


def test_known_api_route_still_works_alongside_mount(client):
    r = client.get("/api/auth/me")
    assert r.status_code == 200
    assert r.json()["authenticated"] is False


def test_app_is_api_only_when_dist_missing(tmp_path, monkeypatch):
    # The real repo has a built web/dist, so force the "not found" path
    # directly rather than relying on env-var override (which would just
    # fall through to that real directory).
    monkeypatch.setattr(app_module, "_find_web_dist", lambda: None)
    data_dir = str(tmp_path / "server2")
    bootstrap.ensure_installed(data_dir, lang="en", url="http://h", interactive=False)
    app = app_module.create_app(data_dir)
    c = TestClient(app)

    # No SPA mount was registered, so this is Starlette's plain built-in 404
    # for an unmatched route (not our JSON error handler, which only kicks in
    # for routes that exist, i.e. the API routers) -- the point of this test
    # is just that create_app() doesn't require web/dist to exist.
    r = c.get("/")
    assert r.status_code == 404

    r = c.get("/api/auth/me")
    assert r.status_code == 200
