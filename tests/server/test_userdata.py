"""`/comfy/api/userdata` -- the panel's workflow save/load surface.

Shapes here are dictated by the pinned ComfyUI frontend (1.52.x), not by
ComfyFed's own conventions -- see `comfyapi.create_router`'s userdata section
for the exact `api.ts` calls each route answers. Harness idioms (fixture,
`_login`, `_create_user`, ALICE/BOB) mirror `test_comfyapi.py`.
"""

import json
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


WORKFLOW = {"1": {"class_type": "KSampler", "inputs": {"seed": 1}}}


def _store(client, path, body=None, **params):
    return client.post(
        f"/comfy/api/userdata/{path}",
        params=params,
        content=json.dumps(body if body is not None else WORKFLOW),
    )


# --- userdata round trip ---------------------------------------------------


def test_userdata_round_trip(client):
    _login(client)

    # Nothing saved yet: a missing dir lists as an empty array, 200 (the
    # frontend's very first call on a fresh account).
    listing = client.get("/comfy/api/userdata", params={"dir": "workflows", "recurse": "true", "split": "false", "full_info": "true"})
    assert listing.status_code == 200
    assert listing.json() == []

    stored = _store(client, "workflows%2Fmy%20flow.json")
    assert stored.status_code == 200, stored.text
    info = stored.json()
    assert info["path"] == "workflows/my flow.json"
    assert info["size"] > 0
    assert isinstance(info["modified"], (int, float))

    # The exact call the pinned frontend's workflow browser makes.
    listing = client.get(
        "/comfy/api/userdata",
        params={"dir": "workflows", "recurse": "true", "split": "false", "full_info": "true"},
    )
    assert listing.status_code == 200
    entries = listing.json()
    # `path` is relative to the REQUESTED dir -- `syncEntities` re-prefixes
    # the dir, so a root-relative path would double it.
    assert [e["path"] for e in entries] == ["my flow.json"]
    assert entries[0]["size"] == info["size"]

    fetched = client.get("/comfy/api/userdata/workflows%2Fmy%20flow.json")
    assert fetched.status_code == 200
    assert json.loads(fetched.content) == WORKFLOW

    deleted = client.delete("/comfy/api/userdata/workflows%2Fmy%20flow.json")
    assert deleted.status_code == 204
    assert client.get("/comfy/api/userdata/workflows%2Fmy%20flow.json").status_code == 404
    assert client.delete("/comfy/api/userdata/workflows%2Fmy%20flow.json").status_code == 404


def test_userdata_listing_variants(client):
    _login(client)
    assert _store(client, "workflows%2Ftop.json").status_code == 200
    assert _store(client, "workflows%2Fsub%2Fdeep.json").status_code == 200

    plain = client.get("/comfy/api/userdata", params={"dir": "workflows", "recurse": "true"})
    assert plain.json() == ["sub/deep.json", "top.json"]

    shallow = client.get("/comfy/api/userdata", params={"dir": "workflows", "recurse": "false"})
    assert shallow.json() == ["top.json"]

    split = client.get(
        "/comfy/api/userdata", params={"dir": "workflows", "recurse": "true", "split": "true"}
    )
    assert split.json() == [["sub/deep.json", "sub", "deep.json"], ["top.json", "top.json"]]

    # dir omitted => the whole user root, paths relative to it.
    root = client.get("/comfy/api/userdata", params={"recurse": "true", "full_info": "true"})
    assert sorted(e["path"] for e in root.json()) == ["workflows/sub/deep.json", "workflows/top.json"]


def test_userdata_overwrite_semantics(client):
    _login(client)
    assert _store(client, "workflows%2Fa.json").status_code == 200

    conflict = _store(client, "workflows%2Fa.json", overwrite="false")
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "userdata.exists"

    # Default is overwrite=true (a plain re-save), and an explicit true works.
    assert _store(client, "workflows%2Fa.json", {"v": 2}).status_code == 200
    assert _store(client, "workflows%2Fa.json", {"v": 3}, overwrite="true").status_code == 200
    assert json.loads(client.get("/comfy/api/userdata/workflows%2Fa.json").content) == {"v": 3}


def test_userdata_move(client):
    _login(client)
    assert _store(client, "workflows%2Fold.json").status_code == 200

    moved = client.post("/comfy/api/userdata/workflows%2Fold.json/move/workflows%2Fnew.json")
    assert moved.status_code == 200, moved.text
    assert moved.json()["path"] == "workflows/new.json"
    assert client.get("/comfy/api/userdata/workflows%2Fold.json").status_code == 404
    assert client.get("/comfy/api/userdata/workflows%2Fnew.json").status_code == 200

    missing = client.post("/comfy/api/userdata/workflows%2Fnope.json/move/workflows%2Fx.json")
    assert missing.status_code == 404

    assert _store(client, "workflows%2Fother.json").status_code == 200
    clash = client.post("/comfy/api/userdata/workflows%2Fother.json/move/workflows%2Fnew.json")
    assert clash.status_code == 409
    assert clash.json()["error"]["code"] == "userdata.exists"
    forced = client.post(
        "/comfy/api/userdata/workflows%2Fother.json/move/workflows%2Fnew.json",
        params={"overwrite": "true"},
    )
    assert forced.status_code == 200


@pytest.mark.parametrize(
    "bad",
    [
        "..%2Fescape.json",
        "workflows%2F..%2F..%2Fsecret.json",
        "%2Fetc%2Fpasswd",
        "workflows%2F..%2F..%2F..%2Fcomfy_settings.json",
    ],
)
def test_userdata_rejects_traversal(client, bad):
    _login(client)
    assert client.post(f"/comfy/api/userdata/{bad}", content=b"x").status_code == 400
    assert client.get(f"/comfy/api/userdata/{bad}").status_code == 400
    assert client.delete(f"/comfy/api/userdata/{bad}").status_code == 400
    assert client.get("/comfy/api/userdata", params={"dir": "../.."}).status_code == 400


def test_userdata_rejects_oversized_file(client):
    _login(client)
    big = b"x" * (5 * 1024 * 1024 + 1)
    r = client.post("/comfy/api/userdata/workflows%2Fbig.json", content=big)
    assert r.status_code == 413
    assert r.json()["error"]["code"] == "userdata.too_large"
    assert "5 MB" in r.json()["error"]["message"]
    # Just under the limit still stores.
    ok = client.post("/comfy/api/userdata/workflows%2Fok.json", content=b"y" * (5 * 1024 * 1024))
    assert ok.status_code == 200


def test_userdata_requires_a_session(client):
    assert client.get("/comfy/api/userdata").status_code == 401
    assert client.get("/comfy/api/userdata/workflows%2Fa.json").status_code == 401
    assert client.post("/comfy/api/userdata/workflows%2Fa.json", content=b"{}").status_code == 401
    assert client.delete("/comfy/api/userdata/workflows%2Fa.json").status_code == 401


def test_userdata_is_isolated_per_user(client, two_users):
    _login(client, *ALICE)
    assert _store(client, "workflows%2Fsecret.json", {"owner": "alice"}).status_code == 200

    _login(client, *BOB)
    # Bob cannot read, list, move or delete Alice's file even knowing its name.
    assert client.get("/comfy/api/userdata/workflows%2Fsecret.json").status_code == 404
    assert client.get(
        "/comfy/api/userdata", params={"dir": "workflows", "recurse": "true", "full_info": "true"}
    ).json() == []
    assert client.delete("/comfy/api/userdata/workflows%2Fsecret.json").status_code == 404
    assert client.post(
        "/comfy/api/userdata/workflows%2Fsecret.json/move/workflows%2Fstolen.json"
    ).status_code == 404

    # Bob writing the same name touches only his own tree.
    assert _store(client, "workflows%2Fsecret.json", {"owner": "bob"}).status_code == 200
    assert json.loads(client.get("/comfy/api/userdata/workflows%2Fsecret.json").content) == {"owner": "bob"}

    _login(client, *ALICE)
    assert json.loads(client.get("/comfy/api/userdata/workflows%2Fsecret.json").content) == {"owner": "alice"}

    # On disk: two separate per-uid trees, not one shared one.
    alice_dir = comfyapi.userdata_dir(client.data_dir, _uid("alice"))
    bob_dir = comfyapi.userdata_dir(client.data_dir, _uid("bob"))
    assert alice_dir != bob_dir
    assert os.path.isfile(os.path.join(alice_dir, "workflows", "secret.json"))
    assert os.path.isfile(os.path.join(bob_dir, "workflows", "secret.json"))


def test_admin_has_no_userdata_override(client, two_users):
    _login(client, *ALICE)
    assert _store(client, "workflows%2Fprivate.json").status_code == 200

    _login(client)  # admin
    assert client.get("/comfy/api/userdata/workflows%2Fprivate.json").status_code == 404
    assert client.get(
        "/comfy/api/userdata", params={"dir": "workflows", "recurse": "true", "full_info": "true"}
    ).json() == []
