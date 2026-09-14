"""Phase 3.0 Task 3: per-user job ownership & console scoping.

Console `POST /api/jobs` stamps `user_id` on the row it creates; `GET
/api/jobs` and the per-job routes (`GET /{id}`, `/assessment`,
`/artifacts/{filename}`, `POST /cancel`, `POST /retry`) are owner-or-admin
scoped -- a non-owner non-admin gets 404 (not 403) so job existence isn't
leaked. Admin sees every job (with a `username` field); a plain user sees
only their own.

`TestClient` shares one cookie jar across the whole test, so unlike the
console (a real browser per user), acting "as" a different user here means
re-logging-in right before that action to swap the active session cookie --
`_login` always returns a csrf token that matches whichever session is
CURRENTLY active after it returns, so tests call it immediately before each
action rather than caching a token from an earlier login.
"""

import io
import json

import pytest
from fastapi.testclient import TestClient

from comfyfed_server import app as app_module
from comfyfed_server import bootstrap, db


@pytest.fixture()
def client(tmp_path):
    data_dir = str(tmp_path)
    result = bootstrap.ensure_installed(data_dir, lang="en", url="http://h", interactive=False)
    app = app_module.create_app(data_dir)
    c = TestClient(app)
    c.admin_password = result.admin_password
    c.data_dir = data_dir
    return c


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


SIMPLE_WORKFLOW = {"1": {"class_type": "KSampler", "inputs": {"seed": 1}}}


def _submit(client, csrf, workflow=None):
    data = {"workflow_json": json.dumps(workflow if workflow is not None else SIMPLE_WORKFLOW)}
    return client.post("/api/jobs", data=data, files=[], headers={"X-CSRF": csrf})


@pytest.fixture()
def two_users(client):
    """Creates admin (bootstrap) + two plain users, alice and bob.

    Leaves NO particular session active on return -- callers must
    `_login(client, "alice", ALICE_PW)` (etc.) right before acting as one of
    them, since the client's single cookie jar can only hold one active
    session at a time.
    """
    admin_csrf = _login(client)
    _create_user(client, admin_csrf, "alice", password="alice-pw-123")
    _create_user(client, admin_csrf, "bob", password="bob-pw-123")
    return {"admin_pw": client.admin_password}


ALICE = ("alice", "alice-pw-123")
BOB = ("bob", "bob-pw-123")


def _login_as(client, who):
    username, password = who
    return _login(client, username, password)


def test_console_submit_stamps_user_id(client, two_users):
    csrf = _login_as(client, ALICE)
    job_id = _submit(client, csrf).json()["job_id"]

    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        alice = session.query(db.User).filter(db.User.username == "alice").one()
        assert job.user_id == alice.id


def test_panel_prompt_submit_stamps_user_id(client, two_users):
    """The panel surface itself stays admin-gated until Task 4 -- only an
    admin session can reach `/comfy/api/prompt` today -- but the stamping
    logic underneath must resolve whoever the CURRENT session actually is
    rather than assuming admin, so this asserts the stamped id is the
    logged-in admin's own uid (not e.g. hardcoded or omitted)."""
    _login(client)  # admin (bootstrap)
    r = client.post("/comfy/api/prompt", json={"prompt": SIMPLE_WORKFLOW})
    assert r.status_code == 200, r.text
    job_id = r.json()["prompt_id"]

    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        admin = session.query(db.User).filter(db.User.username == "admin").one()
        assert job.user_id == admin.id


def test_list_jobs_requires_login(client):
    r = client.get("/api/jobs")
    assert r.status_code == 401


def test_non_admin_list_only_sees_own_jobs(client, two_users):
    alice_csrf = _login_as(client, ALICE)
    alice_job = _submit(client, alice_csrf).json()["job_id"]

    bob_csrf = _login_as(client, BOB)
    bob_job = _submit(client, bob_csrf).json()["job_id"]

    listed = client.get("/api/jobs", headers={"X-CSRF": bob_csrf}).json()
    ids = [j["id"] for j in listed]
    assert bob_job in ids
    assert alice_job not in ids


def test_non_admin_list_includes_own_username_for_shape_consistency(client, two_users):
    csrf = _login_as(client, ALICE)
    _submit(client, csrf)
    listed = client.get("/api/jobs", headers={"X-CSRF": csrf}).json()
    assert listed
    assert all(j["username"] == "alice" for j in listed)


def test_admin_list_sees_all_jobs_with_username(client, two_users):
    alice_csrf = _login_as(client, ALICE)
    alice_job = _submit(client, alice_csrf).json()["job_id"]

    bob_csrf = _login_as(client, BOB)
    bob_job = _submit(client, bob_csrf).json()["job_id"]

    admin_csrf = _login(client)
    listed = client.get("/api/jobs", headers={"X-CSRF": admin_csrf}).json()
    by_id = {j["id"]: j for j in listed}
    assert alice_job in by_id and by_id[alice_job]["username"] == "alice"
    assert bob_job in by_id and by_id[bob_job]["username"] == "bob"


def test_admin_list_shows_null_username_for_legacy_null_user_id(client, two_users):
    """A job with no user_id (e.g. pre-migration data) must not disappear or
    crash the admin listing -- it surfaces with `username: null`."""
    admin_csrf = _login(client)
    job_id = _submit(client, admin_csrf).json()["job_id"]
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        job.user_id = None
        session.commit()

    listed = client.get("/api/jobs", headers={"X-CSRF": admin_csrf}).json()
    entry = next(j for j in listed if j["id"] == job_id)
    assert entry["username"] is None


def test_non_owner_get_job_detail_is_404(client, two_users):
    alice_csrf = _login_as(client, ALICE)
    job_id = _submit(client, alice_csrf).json()["job_id"]

    bob_csrf = _login_as(client, BOB)
    r = client.get(f"/api/jobs/{job_id}", headers={"X-CSRF": bob_csrf})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "jobs.not_found"


def test_owner_can_get_own_job_detail(client, two_users):
    csrf = _login_as(client, ALICE)
    job_id = _submit(client, csrf).json()["job_id"]
    r = client.get(f"/api/jobs/{job_id}", headers={"X-CSRF": csrf})
    assert r.status_code == 200
    assert r.json()["id"] == job_id


def test_admin_can_get_any_job_detail(client, two_users):
    alice_csrf = _login_as(client, ALICE)
    job_id = _submit(client, alice_csrf).json()["job_id"]

    admin_csrf = _login(client)
    r = client.get(f"/api/jobs/{job_id}", headers={"X-CSRF": admin_csrf})
    assert r.status_code == 200


def test_non_owner_get_assessment_is_404(client, two_users):
    alice_csrf = _login_as(client, ALICE)
    job_id = _submit(client, alice_csrf).json()["job_id"]

    bob_csrf = _login_as(client, BOB)
    r = client.get(f"/api/jobs/{job_id}/assessment", headers={"X-CSRF": bob_csrf})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "jobs.not_found"


def test_owner_can_get_own_assessment(client, two_users):
    csrf = _login_as(client, ALICE)
    job_id = _submit(client, csrf).json()["job_id"]
    r = client.get(f"/api/jobs/{job_id}/assessment", headers={"X-CSRF": csrf})
    assert r.status_code == 200


def test_non_owner_artifact_download_is_404(client, two_users):
    from comfyfed_server import storage

    alice_csrf = _login_as(client, ALICE)
    job_id = _submit(client, alice_csrf).json()["job_id"]
    store = storage.get_store(client.data_dir)
    store.put(job_id, "out.png", io.BytesIO(b"RESULT-BYTES"))

    bob_csrf = _login_as(client, BOB)
    r = client.get(f"/api/jobs/{job_id}/artifacts/out.png", headers={"X-CSRF": bob_csrf})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "jobs.not_found"


def test_owner_can_download_own_artifact(client, two_users):
    from comfyfed_server import storage

    csrf = _login_as(client, ALICE)
    job_id = _submit(client, csrf).json()["job_id"]
    store = storage.get_store(client.data_dir)
    store.put(job_id, "out.png", io.BytesIO(b"RESULT-BYTES"))

    r = client.get(f"/api/jobs/{job_id}/artifacts/out.png", headers={"X-CSRF": csrf})
    assert r.status_code == 200
    assert r.content == b"RESULT-BYTES"


def test_admin_can_download_any_artifact(client, two_users):
    from comfyfed_server import storage

    alice_csrf = _login_as(client, ALICE)
    job_id = _submit(client, alice_csrf).json()["job_id"]
    store = storage.get_store(client.data_dir)
    store.put(job_id, "out.png", io.BytesIO(b"RESULT-BYTES"))

    admin_csrf = _login(client)
    r = client.get(f"/api/jobs/{job_id}/artifacts/out.png", headers={"X-CSRF": admin_csrf})
    assert r.status_code == 200


def test_non_owner_cancel_is_404(client, two_users):
    alice_csrf = _login_as(client, ALICE)
    job_id = _submit(client, alice_csrf).json()["job_id"]

    bob_csrf = _login_as(client, BOB)
    r = client.post(f"/api/jobs/{job_id}/cancel", headers={"X-CSRF": bob_csrf})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "jobs.not_found"

    with db.get_session() as session:
        assert session.get(db.Job, job_id).status == "queued"


def test_owner_can_cancel_own_job(client, two_users):
    csrf = _login_as(client, ALICE)
    job_id = _submit(client, csrf).json()["job_id"]
    r = client.post(f"/api/jobs/{job_id}/cancel", headers={"X-CSRF": csrf})
    assert r.status_code == 200
    assert r.json() == {"status": "cancelled"}


def test_admin_can_cancel_any_job(client, two_users):
    alice_csrf = _login_as(client, ALICE)
    job_id = _submit(client, alice_csrf).json()["job_id"]

    admin_csrf = _login(client)
    r = client.post(f"/api/jobs/{job_id}/cancel", headers={"X-CSRF": admin_csrf})
    assert r.status_code == 200


def test_cancel_still_requires_csrf_for_owner(client, two_users):
    csrf = _login_as(client, ALICE)
    job_id = _submit(client, csrf).json()["job_id"]
    r = client.post(f"/api/jobs/{job_id}/cancel")
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "auth.csrf"


def test_submit_job_requires_login_not_admin(client, two_users):
    """POST /api/jobs is now any-logged-in-user, not admin-only."""
    csrf = _login_as(client, ALICE)
    r = _submit(client, csrf)
    assert r.status_code == 200


def test_submit_job_without_login_is_401(client):
    r = client.post(
        "/api/jobs",
        data={"workflow_json": json.dumps(SIMPLE_WORKFLOW)},
        files=[],
    )
    assert r.status_code == 401


def _fail_job(job_id):
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        job.status = "failed"
        job.error = "boom"
        session.commit()


def test_owner_can_retry_own_failed_job(client, two_users):
    """Controller ruling: retry is owner-or-admin, same rule as cancel."""
    csrf = _login_as(client, ALICE)
    job_id = _submit(client, csrf).json()["job_id"]
    _fail_job(job_id)

    r = client.post(f"/api/jobs/{job_id}/retry", headers={"X-CSRF": csrf})
    assert r.status_code == 200
    assert r.json() == {"ok": True, "job_id": job_id}

    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        assert job.status == "queued"
        assert job.error is None


def test_non_owner_retry_is_404(client, two_users):
    alice_csrf = _login_as(client, ALICE)
    job_id = _submit(client, alice_csrf).json()["job_id"]
    _fail_job(job_id)

    bob_csrf = _login_as(client, BOB)
    r = client.post(f"/api/jobs/{job_id}/retry", headers={"X-CSRF": bob_csrf})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "jobs.not_found"

    with db.get_session() as session:
        assert session.get(db.Job, job_id).status == "failed"


def test_admin_can_retry_any_failed_job(client, two_users):
    alice_csrf = _login_as(client, ALICE)
    job_id = _submit(client, alice_csrf).json()["job_id"]
    _fail_job(job_id)

    admin_csrf = _login(client)
    r = client.post(f"/api/jobs/{job_id}/retry", headers={"X-CSRF": admin_csrf})
    assert r.status_code == 200

    with db.get_session() as session:
        assert session.get(db.Job, job_id).status == "queued"


def test_retry_still_requires_csrf_for_owner(client, two_users):
    csrf = _login_as(client, ALICE)
    job_id = _submit(client, csrf).json()["job_id"]
    _fail_job(job_id)

    r = client.post(f"/api/jobs/{job_id}/retry")
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "auth.csrf"
