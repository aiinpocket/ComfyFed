import os

import pytest
from fastapi.testclient import TestClient
from nacl.signing import VerifyKey

from comfyfed_server import app as app_module
from comfyfed_server import bootstrap, db, security


@pytest.fixture()
def client(tmp_path):
    data_dir = str(tmp_path)
    result = bootstrap.ensure_installed(data_dir, lang="en", url="http://h", interactive=False)
    app = app_module.create_app(data_dir)
    c = TestClient(app)
    c.admin_password = result.admin_password
    c.data_dir = data_dir
    return c


def _login(client):
    r = client.post("/api/auth/login", json={"username": "admin", "password": client.admin_password})
    assert r.status_code == 200
    return r.json()["csrf"]


def test_issue_token_requires_admin(client):
    r = client.post("/api/workers/tokens", json={"name": "worker-1"})
    assert r.status_code == 401


def test_issue_token_requires_csrf(client):
    _login(client)
    r = client.post("/api/workers/tokens", json={"name": "worker-1"})
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "auth.csrf"


def test_issue_token_and_register_success_with_verifiable_certificate(client):
    csrf = _login(client)
    r = client.post(
        "/api/workers/tokens",
        json={"name": "worker-1"},
        headers={"X-CSRF": csrf},
    )
    assert r.status_code == 200
    bundle = r.json()["bundle"]
    assert bundle["platform_url"] == "http://h"
    assert bundle["platform_pubkey"]
    token = bundle["register_token"]
    assert token

    _, verify_key = security.load_platform_keys(client.data_dir)
    assert bundle["platform_pubkey"] == bytes(verify_key).hex()

    pubkey_hex = "ab" * 32
    reg = client.post(
        "/api/agent/register",
        json={"token": token, "name": "worker-1", "pubkey": pubkey_hex},
    )
    assert reg.status_code == 200
    body = reg.json()
    worker_id = body["worker_id"]
    certificate = body["certificate"]
    assert worker_id

    msg = f"{worker_id}|{pubkey_hex}".encode()
    VerifyKey(bytes(verify_key)).verify(msg, bytes.fromhex(certificate))


def test_register_with_unknown_token_401(client):
    r = client.post(
        "/api/agent/register",
        json={"token": "does-not-exist", "name": "worker-x", "pubkey": "cd" * 32},
    )
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "register.token_invalid"


def test_register_twice_with_same_token_409(client):
    csrf = _login(client)
    r = client.post(
        "/api/workers/tokens",
        json={"name": "worker-2"},
        headers={"X-CSRF": csrf},
    )
    token = r.json()["bundle"]["register_token"]

    first = client.post(
        "/api/agent/register",
        json={"token": token, "name": "worker-2", "pubkey": "ef" * 32},
    )
    assert first.status_code == 200

    second = client.post(
        "/api/agent/register",
        json={"token": token, "name": "worker-2", "pubkey": "ef" * 32},
    )
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "register.token_used"


def test_list_workers_shows_registered_worker(client):
    csrf = _login(client)
    r = client.post(
        "/api/workers/tokens",
        json={"name": "worker-3"},
        headers={"X-CSRF": csrf},
    )
    token = r.json()["bundle"]["register_token"]

    client.post(
        "/api/agent/register",
        json={"token": token, "name": "worker-3", "pubkey": "12" * 32},
    )

    listed = client.get("/api/workers", headers={"X-CSRF": csrf})
    assert listed.status_code == 200
    names = [w["name"] for w in listed.json()]
    assert "worker-3" in names
    worker = next(w for w in listed.json() if w["name"] == "worker-3")
    assert worker["disabled"] is False
    assert "status" in worker and "last_seen" in worker and "id" in worker


def test_list_workers_exposes_peer_url(client):
    """Task 7: `/api/workers` serialization gains `peer_url` (null until the
    agent's `hello.peer_url` sets it -- see agentws._parse_peer_url). Readable
    by any logged-in user now (require_user); workers are shared infrastructure,
    so a peer address is fleet metadata, not per-user private data."""
    csrf = _login(client)
    r = client.post(
        "/api/workers/tokens",
        json={"name": "worker-peer"},
        headers={"X-CSRF": csrf},
    )
    token = r.json()["bundle"]["register_token"]
    reg = client.post(
        "/api/agent/register",
        json={"token": token, "name": "worker-peer", "pubkey": "56" * 32},
    )
    worker_id = reg.json()["worker_id"]

    listed = client.get("/api/workers", headers={"X-CSRF": csrf}).json()
    worker = next(w for w in listed if w["id"] == worker_id)
    assert worker["peer_url"] is None

    with db.get_session() as session:
        w = session.get(db.Worker, worker_id)
        w.peer_url = "http://192.168.1.5:8850"
        session.commit()

    listed_after = client.get("/api/workers", headers={"X-CSRF": csrf}).json()
    worker_after = next(w for w in listed_after if w["id"] == worker_id)
    assert worker_after["peer_url"] == "http://192.168.1.5:8850"


def test_list_workers_exposes_the_p2p_nat_fields(client):
    """Phase 3.4 §6：Workers 頁的 P2P 欄要畫「開埠方式／區網位址／可連性
    徽章」，所以列表要一併吐 `peer_lan_url`／`peer_nat`／`peer_reachable`
    （cloud parity: `cloud/src/routes/workers.ts`）。"""
    csrf = _login(client)
    r = client.post("/api/workers/tokens", json={"name": "worker-nat"}, headers={"X-CSRF": csrf})
    token = r.json()["bundle"]["register_token"]
    reg = client.post(
        "/api/agent/register",
        json={"token": token, "name": "worker-nat", "pubkey": "57" * 32},
    )
    worker_id = reg.json()["worker_id"]

    worker = next(w for w in client.get("/api/workers", headers={"X-CSRF": csrf}).json() if w["id"] == worker_id)
    assert worker["peer_lan_url"] is None
    assert worker["peer_nat"] == "lan"
    assert worker["peer_reachable"] is None

    with db.get_session() as session:
        w = session.get(db.Worker, worker_id)
        w.peer_lan_url = "http://192.168.1.5:8850"
        w.peer_nat = "natpmp"
        w.peer_reachable = 1
        session.commit()

    after = next(w for w in client.get("/api/workers", headers={"X-CSRF": csrf}).json() if w["id"] == worker_id)
    assert after["peer_lan_url"] == "http://192.168.1.5:8850"
    assert after["peer_nat"] == "natpmp"
    assert after["peer_reachable"] == 1


def _login_as_new_user(client, admin_csrf, username):
    """Create a non-admin `user` (as the current admin) then log in as them.

    The TestClient shares one cookie jar, so this REPLACES the admin session
    with the new user's -- do any admin-only setup (worker registration) BEFORE
    calling this."""
    created = client.post(
        "/api/users",
        json={"username": username, "role": "user", "password": "s3cret-password"},
        headers={"X-CSRF": admin_csrf},
    )
    assert created.status_code == 200
    client.post("/api/auth/logout", headers={"X-CSRF": admin_csrf})
    login = client.post(
        "/api/auth/login", json={"username": username, "password": "s3cret-password"}
    )
    assert login.status_code == 200
    return login.json()["csrf"]


def test_list_workers_allows_non_admin_user(client):
    """`GET /api/workers` is a read-only fleet listing any logged-in user may
    load (workers are shared infrastructure) -- changed from require_admin to
    require_user. Register a worker as admin, then read the list as a plain
    user: 200 with the worker present. The mutation routes stay admin-only
    (see the 403 tests below)."""
    csrf = _login(client)
    worker_id = _register(client, csrf, "shared-box", "11" * 32)
    _login_as_new_user(client, csrf, "reader")

    listed = client.get("/api/workers")
    assert listed.status_code == 200
    assert any(w["id"] == worker_id for w in listed.json())


def test_issue_token_requires_admin_role(client):
    """Token issuance stays admin-only: a logged-in non-admin with a valid CSRF
    still gets 403 (route hangs off require_csrf -> require_admin)."""
    csrf = _login(client)
    user_csrf = _login_as_new_user(client, csrf, "reader-token")
    r = client.post("/api/workers/tokens", json={"name": "x"}, headers={"X-CSRF": user_csrf})
    assert r.status_code == 403


def test_disable_worker_requires_admin_role(client):
    """Disable stays admin-only for a logged-in non-admin with a valid CSRF."""
    csrf = _login(client)
    worker_id = _register(client, csrf, "worker-dis-role", "22" * 32)
    user_csrf = _login_as_new_user(client, csrf, "reader-disable")
    r = client.post(f"/api/workers/{worker_id}/disable", headers={"X-CSRF": user_csrf})
    assert r.status_code == 403


def test_disable_worker(client):
    csrf = _login(client)
    r = client.post(
        "/api/workers/tokens",
        json={"name": "worker-4"},
        headers={"X-CSRF": csrf},
    )
    token = r.json()["bundle"]["register_token"]
    reg = client.post(
        "/api/agent/register",
        json={"token": token, "name": "worker-4", "pubkey": "34" * 32},
    )
    worker_id = reg.json()["worker_id"]

    disable = client.post(f"/api/workers/{worker_id}/disable", headers={"X-CSRF": csrf})
    assert disable.status_code == 200

    listed = client.get("/api/workers").json()
    worker = next(w for w in listed if w["id"] == worker_id)
    assert worker["disabled"] is True


def test_disable_unknown_worker_404(client):
    csrf = _login(client)
    r = client.post("/api/workers/does-not-exist/disable", headers={"X-CSRF": csrf})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "workers.not_found"


def test_agent_version_defaults_when_no_settings(client):
    r = client.get("/api/agent/version")
    assert r.status_code == 200
    body = r.json()
    assert body == {
        "latest": "0.1.0",
        "min_supported": "0.1.0",
        "wheel_url": None,
        "sha256": None,
        "platform_sig": None,
    }


def test_agent_version_reads_settings(client):
    with db.get_session() as session:
        session.add(db.Setting(key="agent_latest", value="0.2.0"))
        session.add(db.Setting(key="agent_min_supported", value="0.2.0"))
        session.add(db.Setting(key="agent_wheel_url", value="http://h/api/agent/releases/agent-0.2.0.whl"))
        session.add(db.Setting(key="agent_wheel_sha256", value="deadbeef"))
        session.add(db.Setting(key="agent_wheel_sig", value="abcd"))
        session.commit()

    r = client.get("/api/agent/version")
    assert r.status_code == 200
    body = r.json()
    assert body["latest"] == "0.2.0"
    assert body["min_supported"] == "0.2.0"
    assert body["wheel_url"] == "http://h/api/agent/releases/agent-0.2.0.whl"
    assert body["sha256"] == "deadbeef"
    assert body["platform_sig"] == "abcd"


def test_agent_release_serves_file(client):
    releases_dir = os.path.join(client.data_dir, "releases")
    os.makedirs(releases_dir, exist_ok=True)
    with open(os.path.join(releases_dir, "agent-0.2.0.whl"), "wb") as f:
        f.write(b"fake wheel bytes")

    r = client.get("/api/agent/releases/agent-0.2.0.whl")
    assert r.status_code == 200
    assert r.content == b"fake wheel bytes"


def test_agent_release_missing_404(client):
    r = client.get("/api/agent/releases/does-not-exist.whl")
    assert r.status_code == 404


def test_agent_release_sanitizes_path_traversal(client):
    r = client.get("/api/agent/releases/..%2F..%2Fsecrets.txt")
    assert r.status_code in (404, 400)


# --------------------------------------------------------------- soft delete


def _register(client, csrf, name, pubkey):
    """Issue a register token for `name` and claim it, returning the worker id."""
    r = client.post("/api/workers/tokens", json={"name": name}, headers={"X-CSRF": csrf})
    token = r.json()["bundle"]["register_token"]
    reg = client.post(
        "/api/agent/register",
        json={"token": token, "name": name, "pubkey": pubkey},
    )
    assert reg.status_code == 200
    return reg.json()["worker_id"]


def test_delete_worker_requires_login(client):
    r = client.delete("/api/workers/does-not-exist")
    assert r.status_code == 401


def test_delete_worker_requires_csrf(client):
    _login(client)
    r = client.delete("/api/workers/does-not-exist")
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "auth.csrf"


def test_delete_worker_requires_admin_role(client):
    """A logged-in non-admin gets 403 even with a valid CSRF token -- the
    route hangs off `auth.require_csrf`, which is admin-only."""
    csrf = _login(client)
    worker_id = _register(client, csrf, "worker-del-role", "78" * 32)
    created = client.post(
        "/api/users",
        json={"username": "plainuser", "role": "user", "password": "s3cret-password"},
        headers={"X-CSRF": csrf},
    )
    assert created.status_code == 200

    client.post("/api/auth/logout", headers={"X-CSRF": csrf})
    login = client.post(
        "/api/auth/login", json={"username": "plainuser", "password": "s3cret-password"}
    )
    assert login.status_code == 200
    user_csrf = login.json()["csrf"]

    r = client.delete(f"/api/workers/{worker_id}", headers={"X-CSRF": user_csrf})
    assert r.status_code == 403


def test_delete_worker_soft_deletes_and_hides_from_list(client):
    csrf = _login(client)
    worker_id = _register(client, csrf, "worker-del", "9a" * 32)

    r = client.delete(f"/api/workers/{worker_id}", headers={"X-CSRF": csrf})
    assert r.status_code == 200
    assert r.json() == {"ok": True}

    listed = client.get("/api/workers").json()
    assert all(w["id"] != worker_id for w in listed)

    # The row itself survives -- the billing ledger's receipts/jobs still
    # reference it (see db.Worker.deleted).
    with db.get_session() as session:
        row = session.get(db.Worker, worker_id)
        assert row is not None
        assert row.deleted is True
        assert row.disabled is True


def test_delete_unknown_worker_404(client):
    csrf = _login(client)
    r = client.delete("/api/workers/does-not-exist", headers={"X-CSRF": csrf})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "workers.not_found"


def test_delete_worker_twice_404(client):
    csrf = _login(client)
    worker_id = _register(client, csrf, "worker-del-twice", "bc" * 32)

    first = client.delete(f"/api/workers/{worker_id}", headers={"X-CSRF": csrf})
    assert first.status_code == 200

    second = client.delete(f"/api/workers/{worker_id}", headers={"X-CSRF": csrf})
    assert second.status_code == 404
    assert second.json()["error"]["code"] == "workers.not_found"


# --- 2026-09-19 job-retry §8：worker 的不適任任務清單與清除 -----------------


def _seed_failure(worker_id, task_key, failures, days_ago=0, error="boom", job_id="j-old"):
    from datetime import datetime, timedelta, timezone

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    with db.get_session() as session:
        session.add(
            db.WorkerTaskFailure(
                worker_id=worker_id,
                task_key=task_key,
                failures=failures,
                last_error=error,
                last_job_id=job_id,
                updated_at=now - timedelta(days=days_ago),
            )
        )
        session.commit()


def test_list_workers_reports_unsuitable_tasks_with_active_flags(client):
    """每台 worker 多帶 `unsuitable`：達門檻且未過 TTL -> active True；
    未達門檻或已過 TTL 的列照樣列出來（管理員要看得到歷史），只是 False。"""
    csrf = _login(client)
    worker_id = _register(client, csrf, "worker-unsuitable", "61" * 32)
    other_id = _register(client, csrf, "worker-other", "62" * 32)
    _seed_failure(worker_id, "sig-active", failures=2, error="CUDA OOM", job_id="j-1")
    _seed_failure(worker_id, "sig-expired", failures=3, days_ago=9)
    _seed_failure(worker_id, "sig-once", failures=1)
    _seed_failure(other_id, "sig-elsewhere", failures=2)

    listed = client.get("/api/workers", headers={"X-CSRF": csrf}).json()
    worker = next(w for w in listed if w["id"] == worker_id)
    by_key = {row["task_key"]: row for row in worker["unsuitable"]}

    assert set(by_key) == {"sig-active", "sig-expired", "sig-once"}
    assert by_key["sig-active"]["active"] is True
    assert by_key["sig-active"]["failures"] == 2
    assert by_key["sig-active"]["last_error"] == "CUDA OOM"
    assert by_key["sig-active"]["last_job_id"] == "j-1"
    assert by_key["sig-active"]["updated_at"]
    assert by_key["sig-expired"]["active"] is False
    assert by_key["sig-once"]["active"] is False

    other = next(w for w in listed if w["id"] == other_id)
    assert [row["task_key"] for row in other["unsuitable"]] == ["sig-elsewhere"]


def test_list_workers_hides_unsuitable_error_and_job_id_from_a_non_admin(client):
    """final review I1：`worker_task_failures` 跨 job、跨使用者累積，所以
    `last_error`（失敗原文，常含檔名／LoRA 名稱／絕對路徑）與 `last_job_id`
    （別人的 job id）只有 admin 讀得到。非 admin 照樣拿得到那一列本身
    （task_key / failures / updated_at / active）-- 那是艦隊 metadata。"""
    csrf = _login(client)
    worker_id = _register(client, csrf, "worker-leak", "65" * 32)
    _seed_failure(
        worker_id,
        "sig-leaky",
        failures=2,
        error="C:/models/loras/private-style.safetensors not found",
        job_id="job-of-someone-else",
    )

    admin_worker = next(
        w for w in client.get("/api/workers", headers={"X-CSRF": csrf}).json() if w["id"] == worker_id
    )
    admin_row = admin_worker["unsuitable"][0]
    assert admin_row["last_error"] == "C:/models/loras/private-style.safetensors not found"
    assert admin_row["last_job_id"] == "job-of-someone-else"

    _login_as_new_user(client, csrf, "unsuitable-reader")
    listed = client.get("/api/workers")
    assert listed.status_code == 200
    user_row = next(w for w in listed.json() if w["id"] == worker_id)["unsuitable"][0]
    assert user_row["last_error"] is None
    assert user_row["last_job_id"] is None
    # 該列本身還在，而且非私有欄位和 admin 看到的一致。
    assert user_row["task_key"] == "sig-leaky"
    assert user_row["failures"] == 2
    assert user_row["active"] is True
    assert user_row["updated_at"] == admin_row["updated_at"]


def test_list_workers_unsuitable_is_empty_for_a_clean_worker(client):
    csrf = _login(client)
    worker_id = _register(client, csrf, "worker-clean", "63" * 32)
    listed = client.get("/api/workers", headers={"X-CSRF": csrf}).json()
    assert next(w for w in listed if w["id"] == worker_id)["unsuitable"] == []


def test_clear_one_unsuitable_task_key(client):
    csrf = _login(client)
    worker_id = _register(client, csrf, "worker-clear-one", "64" * 32)
    _seed_failure(worker_id, "sig-a", failures=2)
    _seed_failure(worker_id, "sig-b", failures=2)

    r = client.delete(
        "/api/workers/%s/unsuitable/sig-a" % worker_id, headers={"X-CSRF": csrf}
    )
    assert r.status_code == 200
    assert r.json() == {"cleared": 1}

    listed = client.get("/api/workers", headers={"X-CSRF": csrf}).json()
    worker = next(w for w in listed if w["id"] == worker_id)
    assert [row["task_key"] for row in worker["unsuitable"]] == ["sig-b"]

    # 再清一次就是 0 列 -- 冪等，不是 404。
    again = client.delete(
        "/api/workers/%s/unsuitable/sig-a" % worker_id, headers={"X-CSRF": csrf}
    )
    assert again.status_code == 200
    assert again.json() == {"cleared": 0}


def test_clear_all_unsuitable_tasks_for_one_worker(client):
    csrf = _login(client)
    worker_id = _register(client, csrf, "worker-clear-all", "65" * 32)
    other_id = _register(client, csrf, "worker-untouched", "66" * 32)
    _seed_failure(worker_id, "sig-a", failures=2)
    _seed_failure(worker_id, "sig-b", failures=1)
    _seed_failure(other_id, "sig-a", failures=2)

    r = client.delete("/api/workers/%s/unsuitable" % worker_id, headers={"X-CSRF": csrf})
    assert r.status_code == 200
    assert r.json() == {"cleared": 2}

    listed = client.get("/api/workers", headers={"X-CSRF": csrf}).json()
    assert next(w for w in listed if w["id"] == worker_id)["unsuitable"] == []
    # 別台的紀錄一動也沒動。
    assert len(next(w for w in listed if w["id"] == other_id)["unsuitable"]) == 1


def test_clear_unsuitable_for_an_unknown_worker_is_404(client):
    csrf = _login(client)
    assert client.delete("/api/workers/nope/unsuitable", headers={"X-CSRF": csrf}).status_code == 404
    r = client.delete("/api/workers/nope/unsuitable/sig-a", headers={"X-CSRF": csrf})
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "workers.not_found"


def test_clear_unsuitable_requires_csrf(client):
    csrf = _login(client)
    worker_id = _register(client, csrf, "worker-csrf", "67" * 32)
    r = client.delete("/api/workers/%s/unsuitable" % worker_id)
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "auth.csrf"


def test_clear_unsuitable_requires_admin_role(client):
    """清除是 admin-only：登入的一般使用者帶著有效 CSRF 也是 403。"""
    csrf = _login(client)
    worker_id = _register(client, csrf, "worker-role", "68" * 32)
    _seed_failure(worker_id, "sig-a", failures=2)
    user_csrf = _login_as_new_user(client, csrf, "reader-unsuitable")

    assert (
        client.delete(
            "/api/workers/%s/unsuitable" % worker_id, headers={"X-CSRF": user_csrf}
        ).status_code
        == 403
    )
    assert (
        client.delete(
            "/api/workers/%s/unsuitable/sig-a" % worker_id, headers={"X-CSRF": user_csrf}
        ).status_code
        == 403
    )
    # 一般使用者讀得到清單（workers 是共用基礎設施），只是不能清。
    listed = client.get("/api/workers")
    assert listed.status_code == 200
    worker = next(w for w in listed.json() if w["id"] == worker_id)
    assert [row["task_key"] for row in worker["unsuitable"]] == ["sig-a"]
