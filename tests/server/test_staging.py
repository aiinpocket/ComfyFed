"""`/api/staging` -- the console's per-user management of uploaded reference
files (list + delete), the counterpart to `/comfy/api/upload/image`.

This is ComfyFed's OWN console API (standard error envelope, `X-CSRF` on the
mutation), not a ComfyUI-compatible surface -- see
`comfyapi.create_staging_router`. Harness idioms (fixture,
`_login`, `_create_user`, ALICE/BOB) mirror `test_comfyapi.py`.
"""

import io
import os

import pytest
from fastapi.testclient import TestClient

from comfyfed_server import app as app_module
from comfyfed_server import bootstrap, comfyapi, db


@pytest.fixture()
def client(tmp_path):
    comfyapi.clear_object_info_cache()
    data_dir = str(tmp_path)
    result = bootstrap.ensure_installed(data_dir, lang="en", url="http://h", interactive=False)
    app = app_module.create_app(data_dir)
    c = TestClient(app)
    c.admin_password = result.admin_password
    c.data_dir = data_dir
    yield c


def _login(client, username="admin", password=None):
    r = client.post(
        "/api/auth/login",
        json={"username": username, "password": password or client.admin_password},
    )
    assert r.status_code == 200, r.text
    return r.json()["csrf"]


def _create_user(client, admin_csrf, username, role="user", password="password123"):
    r = client.post(
        "/api/users",
        json={"username": username, "role": role, "password": password},
        headers={"X-CSRF": admin_csrf},
    )
    assert r.status_code == 200, r.text
    return r.json()


ALICE = ("alice", "alice-pw-123")
BOB = ("bob", "bob-pw-123")


@pytest.fixture()
def two_users(client):
    """admin (bootstrap) + alice + bob. Leaves NO session active: the
    TestClient has one cookie jar, so each test logs in as who it needs."""
    admin_csrf = _login(client)
    _create_user(client, admin_csrf, ALICE[0], password=ALICE[1])
    _create_user(client, admin_csrf, BOB[0], password=BOB[1])
    return {"admin_csrf": admin_csrf}


def _uid(username):
    with db.get_session() as session:
        return session.query(db.User).filter(db.User.username == username).one().id


def _upload(client, filename, content=b"png-bytes"):
    return client.post(
        "/comfy/api/upload/image",
        files={"image": (filename, io.BytesIO(content), "image/png")},
    )


def test_staging_list_and_delete(client):
    csrf = _login(client)
    assert _upload(client, "ref.png", b"12345").status_code == 200
    assert _upload(client, "mask.png", b"678").status_code == 200

    listed = client.get("/api/staging")
    assert listed.status_code == 200
    body = listed.json()
    assert [f["name"] for f in body["files"]] == ["mask.png", "ref.png"]
    assert {f["name"]: f["size"] for f in body["files"]} == {"mask.png": 3, "ref.png": 5}
    assert body["total_bytes"] == 8
    assert all(isinstance(f["modified"], (int, float)) for f in body["files"])

    deleted = client.delete("/api/staging/ref.png", headers={"X-CSRF": csrf})
    assert deleted.status_code == 200
    after = client.get("/api/staging").json()
    assert [f["name"] for f in after["files"]] == ["mask.png"]
    assert after["total_bytes"] == 3
    assert not os.path.exists(os.path.join(comfyapi.staging_dir(client.data_dir, _uid("admin")), "ref.png"))

    gone = client.delete("/api/staging/ref.png", headers={"X-CSRF": csrf})
    assert gone.status_code == 404
    assert gone.json()["error"]["code"] == "staging.not_found"


def test_staging_delete_requires_csrf(client):
    _login(client)
    assert _upload(client, "ref.png").status_code == 200
    r = client.delete("/api/staging/ref.png")
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "auth.csrf"
    # Still there.
    assert [f["name"] for f in client.get("/api/staging").json()["files"]] == ["ref.png"]


def test_staging_requires_a_session(client):
    assert client.get("/api/staging").status_code == 401
    assert client.delete("/api/staging/ref.png").status_code == 401


def test_staging_rejects_traversal(client):
    csrf = _login(client)
    # Single-segment names only: a separator-bearing name is rejected by the
    # shared sanitizer before it can become a path. (`%2F` is normalized away
    # by the HTTP client itself, so a backslash is what actually reaches the
    # route as one path segment here.)
    r = client.delete("/api/staging/..%5C..%5Ccomfy_settings.json", headers={"X-CSRF": csrf})
    assert r.status_code == 400, r.text
    assert r.json()["error"]["code"] == "staging.bad_name"
    assert os.path.isfile(os.path.join(client.data_dir, "comfyfed.db"))


def test_staging_is_isolated_per_user(client, two_users):
    alice_csrf = _login(client, *ALICE)
    assert _upload(client, "alice.png", b"AAA").status_code == 200

    bob_csrf = _login(client, *BOB)
    assert client.get("/api/staging").json() == {"files": [], "total_bytes": 0}
    # Bob cannot delete Alice's file even knowing its exact name.
    assert client.delete("/api/staging/alice.png", headers={"X-CSRF": bob_csrf}).status_code == 404

    # ... and an admin gets no cross-user view either (staging is personal).
    admin_csrf = _login(client)
    assert client.get("/api/staging").json()["files"] == []
    assert client.delete("/api/staging/alice.png", headers={"X-CSRF": admin_csrf}).status_code == 404

    _login(client, *ALICE)
    assert [f["name"] for f in client.get("/api/staging").json()["files"]] == ["alice.png"]
    assert os.path.isfile(os.path.join(comfyapi.staging_dir(client.data_dir, _uid("alice")), "alice.png"))
