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
    # Single-segment names only: the route refuses BOTH separators explicitly,
    # before any basename-dependent logic, so this is 400 on every OS (
    # `os.path.basename` only splits on `\` when running on Windows, which
    # used to make this assertion platform-dependent). Matches the cloud
    # twin's 400 in test/staging.spec.ts. (`%2F` is normalized away by the
    # HTTP client itself, so a backslash is what actually reaches the route.)
    r = client.delete("/api/staging/..%5C..%5Ccomfy_settings.json", headers={"X-CSRF": csrf})
    assert r.status_code == 400, r.text
    assert r.json()["error"]["code"] == "staging.bad_name"
    assert os.path.isfile(os.path.join(client.data_dir, "comfyfed.db"))


def test_staging_is_isolated_per_user(client, two_users):
    alice_csrf = _login(client, *ALICE)
    assert _upload(client, "alice.png", b"AAA").status_code == 200

    bob_csrf = _login(client, *BOB)
    listing = client.get("/api/staging").json()
    assert listing["files"] == []
    assert listing["total_bytes"] == 0
    assert listing["userdata_bytes"] == 0
    # Bob cannot delete Alice's file even knowing its exact name.
    assert client.delete("/api/staging/alice.png", headers={"X-CSRF": bob_csrf}).status_code == 404

    # ... and an admin gets no cross-user view either (staging is personal).
    admin_csrf = _login(client)
    assert client.get("/api/staging").json()["files"] == []
    assert client.delete("/api/staging/alice.png", headers={"X-CSRF": admin_csrf}).status_code == 404

    _login(client, *ALICE)
    assert [f["name"] for f in client.get("/api/staging").json()["files"]] == ["alice.png"]
    assert os.path.isfile(os.path.join(comfyapi.staging_dir(client.data_dir, _uid("alice")), "alice.png"))


# --- upload limits + per-user storage quota ---------------------------------
#
# `upload_max_file_mb` (default 50) and `upload_user_quota_gb` (default 5) are
# admin settings; this route had NO ceiling at all before, which made staging
# the way around the `/userdata` cap. Parity twin: cloud/test/staging.spec.ts.


def _set_limits(client, csrf, **values):
    r = client.post("/api/settings", json=values, headers={"X-CSRF": csrf})
    assert r.status_code == 200, r.text
    return r.json()


def test_staging_upload_is_capped_at_the_configured_file_size(client):
    csrf = _login(client)
    _set_limits(client, csrf, upload_max_file_mb=1)

    too_big = _upload(client, "big.png", b"x" * (1024 * 1024 + 1))
    assert too_big.status_code == 413, too_big.text
    assert too_big.json()["error"]["code"] == "upload.too_large"
    # zh first, then English -- both halves in one message.
    assert "1 MB 單檔上限" in too_big.json()["error"]["message"]
    assert "1 MB per-file upload limit" in too_big.json()["error"]["message"]
    # Refused before any write.
    assert client.get("/api/staging").json()["files"] == []

    assert _upload(client, "ok.png", b"y" * (1024 * 1024)).status_code == 200


def test_staging_upload_is_refused_when_it_would_exceed_the_quota(client):
    csrf = _login(client)
    # 0.1 GB quota; a 40 MB file fits twice but not three times.
    _set_limits(client, csrf, upload_user_quota_gb=0.1, upload_max_file_mb=50)
    chunk = b"z" * (40 * 1024 * 1024)

    assert _upload(client, "a.png", chunk).status_code == 200
    assert _upload(client, "b.png", chunk).status_code == 200

    over = _upload(client, "c.png", chunk)
    assert over.status_code == 413, over.text
    assert over.json()["error"]["code"] == "quota_exceeded"
    message = over.json()["error"]["message"]
    assert "儲存空間不足（已用 80 MB / 配額 102.4 MB）" in message
    assert "Storage quota exceeded (used 80 MB of 102.4 MB)" in message

    # The refused upload wrote nothing.
    assert sorted(f["name"] for f in client.get("/api/staging").json()["files"]) == [
        "a.png",
        "b.png",
    ]


def test_overwriting_a_staged_file_does_not_double_count_its_bytes(client):
    """A re-upload of the SAME name frees the old bytes, so it must not be
    refused at exactly 100% of quota."""
    csrf = _login(client)
    _set_limits(client, csrf, upload_user_quota_gb=0.1)
    chunk = b"z" * (50 * 1024 * 1024)

    assert _upload(client, "a.png", chunk).status_code == 200
    assert _upload(client, "b.png", chunk).status_code == 200
    # Full to the byte -- but replacing one of them is still allowed.
    assert _upload(client, "a.png", chunk).status_code == 200


def test_quota_counts_userdata_as_well_as_staging(client):
    csrf = _login(client)
    _set_limits(client, csrf, upload_user_quota_gb=0.1, upload_max_file_mb=50)
    assert (
        client.post("/comfy/api/userdata/workflows%2Fbig.json", content=b"u" * (50 * 1024 * 1024)).status_code
        == 200
    )
    assert _upload(client, "a.png", b"z" * (50 * 1024 * 1024)).status_code == 200

    # 100 MB of the 102.4 MB quota is already used, half of it in userdata --
    # a 3 MB staging upload only overflows if BOTH namespaces are counted.
    over = _upload(client, "b.png", b"z" * (3 * 1024 * 1024))
    assert over.status_code == 413, over.text
    assert over.json()["error"]["code"] == "quota_exceeded"
    assert "已用 100 MB" in over.json()["error"]["message"]


def test_job_artifacts_do_not_count_toward_the_quota(client):
    """Artifacts are RESULTS, not files the user chose to keep -- a full
    `artifacts/` tree must never block an upload (see limits.py)."""
    from comfyfed_server import limits

    csrf = _login(client)
    _set_limits(client, csrf, upload_user_quota_gb=0.1)
    artifacts = os.path.join(client.data_dir, "artifacts", "job-1")
    os.makedirs(artifacts, exist_ok=True)
    with open(os.path.join(artifacts, "out.png"), "wb") as f:
        f.write(b"a" * (80 * 1024 * 1024))

    uid = _uid("admin")
    assert limits.usage_bytes(client.data_dir, uid) == 0
    assert _upload(client, "ref.png", b"z" * (50 * 1024 * 1024)).status_code == 200


def test_staging_listing_reports_usage_and_quota(client):
    csrf = _login(client)
    _set_limits(client, csrf, upload_user_quota_gb=2)
    assert _upload(client, "ref.png", b"12345").status_code == 200
    assert client.post("/comfy/api/userdata/w%2Fa.json", content=b"abc").status_code == 200

    listing = client.get("/api/staging").json()
    assert listing["total_bytes"] == 5
    assert listing["userdata_bytes"] == 3
    assert listing["quota_bytes"] == 2 * 1024 * 1024 * 1024
    # Additive only: the pre-existing shape is untouched.
    assert [f["name"] for f in listing["files"]] == ["ref.png"]


def test_usage_math_matches_the_real_files_on_disk(client):
    from comfyfed_server import limits

    _login(client)
    assert _upload(client, "a.png", b"x" * 700).status_code == 200
    assert client.post("/comfy/api/userdata/w%2Fdeep%2Fb.json", content=b"y" * 300).status_code == 200

    uid = _uid("admin")
    assert limits.usage_bytes(client.data_dir, uid) == 1000
    assert limits.dir_bytes(comfyapi.userdata_dir(client.data_dir, uid)) == 300
