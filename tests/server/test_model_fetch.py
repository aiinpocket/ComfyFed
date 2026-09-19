"""Panel "Download" button -> `kind=model_fetch` job (spec 2026-09-19).

Task 1 covers the pure helpers in `comfyfed_server.model_fetch`: the URL
origin allowlist, the HEAD size probe, and the unverified-source manifest
entry signature. Task 4 adds the route-level branch tests below them.
"""

import httpx
import pytest
from nacl.signing import SigningKey

from comfyfed_server import model_fetch


@pytest.mark.parametrize("url,ok", [
    ("https://huggingface.co/Comfy-Org/x/resolve/main/ae.safetensors", True),
    ("https://HUGGINGFACE.co/a/b", True),
    ("https://civitai.com/api/download/models/123", True),
    ("https://huggingface.co.evil.com/x", False),
    ("http://huggingface.co/x", False),
    ("https://storage.googleapis.com/x", False),
    ("not a url", False),
    ("", False),
])
def test_is_trusted_url(url, ok):
    assert model_fetch.is_trusted_url(url) is ok


def test_unverified_payload_shape():
    assert (
        model_fetch.unverified_payload("ae.safetensors", "vae", "https://huggingface.co/x", 335)
        == "ae.safetensors|vae|https://huggingface.co/x|335|unverified"
    )


def test_sign_unverified_entry_verifies_with_platform_key():
    key = SigningKey.generate()
    entry = model_fetch.sign_unverified_entry(
        key, name="ae.safetensors", directory="vae", url="https://huggingface.co/x", size_bytes=335
    )
    assert entry["unverified"] is True and entry["sha256"] is None and entry["backup_url"] is None
    key.verify_key.verify(
        model_fetch.unverified_payload("ae.safetensors", "vae", "https://huggingface.co/x", 335).encode(),
        bytes.fromhex(entry["sig"]),
    )
    assert model_fetch.is_unverified_entry(entry)
    assert not model_fetch.is_unverified_entry({"name": "x", "sha256": "ab" * 32, "size_bytes": 1})


def _client(handler):
    return lambda **kw: httpx.Client(transport=httpx.MockTransport(handler), **kw)


def test_head_size_bytes_follows_redirect_and_reads_content_length():
    """An allowlisted -> allowlisted redirect is followed by hand and the
    final hop's Content-Length is what comes back."""
    def handler(request):
        if request.url.path == "/a":
            return httpx.Response(302, headers={"location": "https://civitai.com/b"})
        return httpx.Response(200, headers={"content-length": "12345"})
    assert model_fetch.head_size_bytes("https://huggingface.co/a", client_factory=_client(handler)) == 12345


def test_head_size_bytes_follows_a_relative_redirect():
    """A relative Location resolves against the hop that issued it, so it
    stays on the allowlisted origin rather than failing the origin check."""
    def handler(request):
        if request.url.path == "/a":
            return httpx.Response(302, headers={"location": "/b"})
        assert request.url.host == "huggingface.co"
        return httpx.Response(200, headers={"content-length": "777"})
    assert model_fetch.head_size_bytes("https://huggingface.co/a", client_factory=_client(handler)) == 777


@pytest.mark.parametrize("location", [
    "http://127.0.0.1:6379/",          # SSRF / internal port oracle
    "https://192.168.1.10:8080/x",     # LAN address
    "https://evil.example/x",          # simply off the allowlist
    "https://huggingface.co.evil.com/x",  # the prefix-match trap, one hop later
    "https://huggingface.co:8443/x",   # right host, different endpoint
])
def test_head_size_bytes_refuses_a_redirect_off_the_allowlist(location):
    """Final-review I4: the allowlist is checked BEFORE the first request,
    but a redirect would otherwise carry the probe anywhere. Every hop must
    clear `is_trusted_url`, and the off-allowlist hop is never requested at
    all (the handler asserts it is not)."""
    requested = []

    def handler(request):
        requested.append(str(request.url))
        if request.url.path == "/a":
            return httpx.Response(302, headers={"location": location})
        raise AssertionError(f"off-allowlist hop was actually requested: {request.url}")

    with pytest.raises(model_fetch.HeadError) as exc:
        model_fetch.head_size_bytes("https://huggingface.co/a", client_factory=_client(handler))
    # Reuses the pre-HEAD allowlist code so the panel gets the existing
    # `model_fetch.untrusted_url` 400 and its existing message.
    assert exc.value.code == "untrusted_url"
    assert requested == ["https://huggingface.co/a"]


def test_head_size_bytes_refuses_more_than_five_redirect_hops():
    """A redirect loop (or a very long chain) must not spin here."""
    def handler(request):
        n = int(request.url.path.lstrip("/") or 0)
        return httpx.Response(302, headers={"location": f"https://huggingface.co/{n + 1}"})

    with pytest.raises(model_fetch.HeadError) as exc:
        model_fetch.head_size_bytes("https://huggingface.co/0", client_factory=_client(handler))
    assert exc.value.code == "size_unknown"
    assert "too many redirects" in str(exc.value)


def test_head_size_bytes_redirect_without_location_is_size_unknown():
    def handler(request):
        return httpx.Response(302)
    with pytest.raises(model_fetch.HeadError) as exc:
        model_fetch.head_size_bytes("https://huggingface.co/a", client_factory=_client(handler))
    assert exc.value.code == "size_unknown"


@pytest.mark.parametrize("status", [401, 403])
def test_head_size_bytes_gated(status):
    def handler(request):
        return httpx.Response(status)
    with pytest.raises(model_fetch.HeadError) as exc:
        model_fetch.head_size_bytes("https://huggingface.co/a", client_factory=_client(handler))
    assert exc.value.code == "gated"


@pytest.mark.parametrize("resp_kwargs", [
    {"status_code": 404},
    {"status_code": 200},
    {"status_code": 200, "headers": {"content-length": "0"}},
    {"status_code": 200, "headers": {"content-length": "abc"}},
])
def test_head_size_bytes_size_unknown(resp_kwargs):
    def handler(request):
        return httpx.Response(**resp_kwargs)
    with pytest.raises(model_fetch.HeadError) as exc:
        model_fetch.head_size_bytes("https://huggingface.co/a", client_factory=_client(handler))
    assert exc.value.code == "size_unknown"


def test_head_size_bytes_network_error_is_size_unknown():
    def handler(request):
        raise httpx.ConnectError("boom")
    with pytest.raises(model_fetch.HeadError) as exc:
        model_fetch.head_size_bytes("https://huggingface.co/a", client_factory=_client(handler))
    assert exc.value.code == "size_unknown"


# --- Task 4: POST/GET /comfy/api/comfyfed/model-fetch ---------------------
#
# Fixtures are local rather than shared: `tests/server/` has no conftest, and
# `test_comfyapi.py` builds its client/login/worker helpers exactly this way.

import json as _json

from fastapi.testclient import TestClient

from comfyfed_server import app as app_module
from comfyfed_server import bootstrap, comfyapi, db


@pytest.fixture()
def client(tmp_path):
    comfyapi.clear_object_info_cache()
    data_dir = str(tmp_path)
    result = bootstrap.ensure_installed(data_dir, lang="en", url="http://h", interactive=False)
    c = TestClient(app_module.create_app(data_dir))
    c.admin_password = result.admin_password
    c.data_dir = data_dir
    yield c


def _login(client):
    r = client.post(
        "/api/auth/login", json={"username": "admin", "password": client.admin_password}
    )
    assert r.status_code == 200, r.text
    return r.json()["csrf"]


@pytest.fixture()
def logged_in_client(client):
    client.csrf = _login(client)
    return client


def _register_worker(
    client,
    name="w1",
    *,
    status="online",
    protocol=5,
    auto_fetch=True,
    free_disk_gb=100.0,
    max_fetch_gb=100,
    models=None,
):
    csrf = getattr(client, "csrf", None) or _login(client)
    r = client.post("/api/workers/tokens", json={"name": name}, headers={"X-CSRF": csrf})
    token = r.json()["bundle"]["register_token"]
    reg = client.post(
        "/api/agent/register", json={"token": token, "name": name, "pubkey": "ab" * 32}
    )
    worker_id = reg.json()["worker_id"]
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        worker.status = status
        worker.protocol = protocol
        worker.auto_fetch = auto_fetch
        worker.dynamic = _json.dumps({"free_disk_gb": free_disk_gb})
        worker.hardware = _json.dumps({"max_fetch_gb": max_fetch_gb})
        worker.model_inventory = _json.dumps(models or [])
        session.commit()
    return worker_id


def _post(client, **body):
    return client.post("/comfy/api/comfyfed/model-fetch", json=body)


# A name the platform has NO curated/learned hash for -- the whole point of
# the unverified-source path. (`ae.safetensors`, the spec's motivating
# example, is one of the 11 curated models and therefore takes the VERIFIED
# manifest branch instead; that case has its own test below.)
BODY = dict(
    name="unknown_vae.safetensors",
    directory="vae",
    url="https://huggingface.co/Comfy-Org/x/resolve/main/unknown_vae.safetensors",
)


def _head_raising(code):
    def _head(url, **kwargs):
        raise model_fetch.HeadError(code)

    return _head


def test_model_fetch_requires_login(client):
    assert _post(client, **BODY).status_code in (401, 403)


def test_model_fetch_bad_request(logged_in_client):
    bad_bodies = [
        {},
        {**BODY, "name": "../x"},
        {**BODY, "name": "a/b"},
        {**BODY, "directory": "../vae"},
        {**BODY, "directory": "/abs"},
        {**BODY, "directory": "C:" + chr(92) + "x"},
        {**BODY, "url": 5},
    ]
    for bad in bad_bodies:
        r = _post(logged_in_client, **bad)
        assert r.status_code == 400, (bad, r.text)
        assert r.json()["error"] == "model_fetch.bad_request"


def test_model_fetch_already_present(logged_in_client):
    """Registered-but-OFFLINE still counts: the model is in the federation,
    the panel just has a stale missing-models card."""
    _register_worker(
        logged_in_client,
        status="offline",
        models=[{"name": "vae/unknown_vae.safetensors", "size": 0.3}],
    )
    r = _post(logged_in_client, **BODY)
    assert r.status_code == 400
    assert r.json()["error"] == "model_fetch.already_present"


def test_model_fetch_untrusted_url(logged_in_client):
    _register_worker(logged_in_client)
    r = _post(logged_in_client, **{**BODY, "url": "https://evil.example/x"})
    assert r.status_code == 400
    assert r.json()["error"] == "model_fetch.untrusted_url"


def test_model_fetch_gated_and_size_unknown(logged_in_client, monkeypatch):
    _register_worker(logged_in_client)
    monkeypatch.setattr(model_fetch, "head_size_bytes", _head_raising("gated"))
    assert _post(logged_in_client, **BODY).json()["error"] == "model_fetch.gated"
    monkeypatch.setattr(model_fetch, "head_size_bytes", _head_raising("size_unknown"))
    assert _post(logged_in_client, **BODY).json()["error"] == "model_fetch.size_unknown"


def test_model_fetch_no_worker(logged_in_client, monkeypatch):
    """protocol 4 is too old to be handed an unverified-source entry."""
    _register_worker(logged_in_client, protocol=4)
    monkeypatch.setattr(model_fetch, "head_size_bytes", lambda url, **k: 335_000_000)
    r = _post(logged_in_client, **BODY)
    assert r.status_code == 400
    assert r.json()["error"] == "model_fetch.no_worker"


def test_model_fetch_creates_then_reuses(logged_in_client, monkeypatch):
    _register_worker(logged_in_client, protocol=5, max_fetch_gb=30)
    monkeypatch.setattr(model_fetch, "head_size_bytes", lambda url, **k: 335_000_000)

    r1 = _post(logged_in_client, **BODY)
    assert r1.status_code == 201, r1.text
    assert r1.json()["reused"] is False
    job_id = r1.json()["job_id"]

    r2 = _post(logged_in_client, **BODY)
    assert r2.status_code == 200
    assert r2.json() == {"job_id": job_id, "reused": True}

    with db.get_session() as s:
        job = s.get(db.Job, job_id)
        assert job.kind == "model_fetch"
        assert job.workflow_json == "{}"
        assert _json.loads(job.required_models) == ["unknown_vae.safetensors"]
        assert _json.loads(job.required_nodes) == []
        assert _json.loads(job.input_assets) == []
        assert job.est_vram_gb is None and job.signature is None and job.split_plan is None
        assert job.origin == "panel" and job.user_id
        entry = _json.loads(job.fetch_entry)
    assert entry["unverified"] is True
    assert entry["size_bytes"] == 335_000_000
    assert entry["url"] == BODY["url"]
    assert entry["sha256"] is None and entry["backup_url"] is None

    st = logged_in_client.get("/comfy/api/comfyfed/model-fetch/" + job_id).json()
    assert st["status"] == "queued"
    assert st["name"] == "unknown_vae.safetensors"
    assert st["stage"] is None and st["fetch_pct"] is None and st["fetch_model"] is None
    assert st["worker_id"] is None and st["error"] is None


def test_model_fetch_entry_signature_verifies_with_the_platform_key(logged_in_client, monkeypatch):
    from comfyfed_server import security

    _register_worker(logged_in_client, protocol=5, max_fetch_gb=30)
    monkeypatch.setattr(model_fetch, "head_size_bytes", lambda url, **k: 335_000_000)
    job_id = _post(logged_in_client, **BODY).json()["job_id"]
    with db.get_session() as s:
        entry = _json.loads(s.get(db.Job, job_id).fetch_entry)

    _sk, vk = security.load_platform_keys(logged_in_client.data_dir)
    vk.verify(
        model_fetch.unverified_payload(
            "unknown_vae.safetensors", "vae", BODY["url"], 335_000_000
        ).encode(),
        bytes.fromhex(entry["sig"]),
    )


def test_model_fetch_uses_verified_manifest_entry_when_known(logged_in_client):
    """`RealESRGAN_x4plus.pth` is curated with an operator-vouched sha256, so
    `model_manifest.entries()` signs a zero-holder VERIFIED entry for it --
    the url in the request is ignored entirely (no allowlist check, no HEAD).

    Final-review I1: the entry being verified does NOT relax the protocol
    floor. The spec's §5.1 row-4 carve-out ("沿用既有 >=3") was wrong -- a
    protocol-3/4 agent ignores the `kind` field entirely and would run the
    `{}` placeholder workflow -- so protocol 5 is required here too."""
    _register_worker(logged_in_client, protocol=5, max_fetch_gb=30)
    r = _post(
        logged_in_client,
        name="RealESRGAN_x4plus.pth",
        directory="upscale_models",
        url="https://evil.example/ignored",
    )
    assert r.status_code == 201, r.text
    with db.get_session() as s:
        entry = _json.loads(s.get(db.Job, r.json()["job_id"]).fetch_entry)
    assert entry.get("unverified") is not True
    assert len(entry["sha256"]) == 64
    assert entry["url"] != "https://evil.example/ignored"


@pytest.mark.parametrize("protocol", [3, 4])
def test_model_fetch_verified_entry_still_needs_protocol_5(logged_in_client, protocol):
    """Final-review I1: a curated (VERIFIED) entry leaves `unverified` empty,
    so the entry-keyed protocol gate cannot fire -- and without the kind-keyed
    one a protocol 3/4 worker would be offered a `kind=model_fetch` job it
    does not understand, set `started_at` (spec §8 says never) and fail the
    `{}` placeholder workflow. The refusal names the protocol as the reason,
    not "nobody has the disk"."""
    _register_worker(logged_in_client, protocol=protocol, max_fetch_gb=30)
    r = _post(
        logged_in_client,
        name="RealESRGAN_x4plus.pth",
        directory="upscale_models",
        url="https://huggingface.co/x/resolve/main/RealESRGAN_x4plus.pth",
    )
    assert r.status_code == 400, r.text
    assert r.json()["error"] == "model_fetch.no_worker"
    assert "model_fetch_protocol:RealESRGAN_x4plus.pth" in r.json()["message"]
    with db.get_session() as s:
        assert s.query(db.Job).filter(db.Job.kind == "model_fetch").count() == 0


def test_model_fetch_status_404_for_prompt_jobs(logged_in_client):
    r = logged_in_client.post(
        "/comfy/api/prompt",
        json={
            "prompt": {"1": {"class_type": "KSampler", "inputs": {"seed": 1}}},
            "client_id": "panel-test",
        },
    )
    assert r.status_code == 200, r.text
    jid = r.json()["prompt_id"]
    assert logged_in_client.get("/comfy/api/comfyfed/model-fetch/" + jid).status_code == 404
    assert logged_in_client.get("/comfy/api/comfyfed/model-fetch/nope").status_code == 404


def test_model_fetch_curated_name_ignores_the_requested_url(logged_in_client, monkeypatch):
    """`ae.safetensors` IS one of the curated models, so even a perfectly
    allowlisted request url never reaches the signed entry -- and no HEAD is
    issued at all (the injected probe would blow up if it were)."""
    def _explode(url, **kwargs):
        raise AssertionError("HEAD must not be probed for a manifest-covered name")

    monkeypatch.setattr(model_fetch, "head_size_bytes", _explode)
    _register_worker(logged_in_client, protocol=5, max_fetch_gb=30)
    r = _post(
        logged_in_client,
        name="ae.safetensors",
        directory="vae",
        url="https://huggingface.co/someone-else/x/resolve/main/ae.safetensors",
    )
    assert r.status_code == 201, r.text
    with db.get_session() as s:
        entry = _json.loads(s.get(db.Job, r.json()["job_id"]).fetch_entry)
    assert entry.get("unverified") is not True
    assert entry["url"] == "https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/ae.safetensors"


# --- Fix round 1 ---------------------------------------------------------


def test_model_fetch_rejects_payload_delimiter_and_control_chars(logged_in_client):
    """`|` is the signature payload's own delimiter and control characters
    would ride it onto the worker's filesystem -- neither may reach a signed
    field, in `name` or in `directory`."""
    bad_bodies = [
        {**BODY, "name": "a|b.safetensors"},
        {**BODY, "name": "a" + chr(10) + "b.safetensors"},
        {**BODY, "name": "a" + chr(0) + "b.safetensors"},
        {**BODY, "name": "a" + chr(127) + "b.safetensors"},
        {**BODY, "directory": "va|e"},
        {**BODY, "directory": "vae" + chr(9)},
    ]
    for bad in bad_bodies:
        r = _post(logged_in_client, **bad)
        assert r.status_code == 400, (bad, r.text)
        assert r.json()["error"] == "model_fetch.bad_request"


def test_model_fetch_rejects_non_object_bodies(logged_in_client):
    """The route bypasses FastAPI's `Body(...)` precisely so a non-object
    body lands in ComfyFed's own 400 envelope, not a 422."""
    for raw in ([], "x", 5, None):
        r = logged_in_client.post("/comfy/api/comfyfed/model-fetch", json=raw)
        assert r.status_code == 400, (raw, r.text)
        assert r.json()["error"] == "model_fetch.bad_request"
        assert r.json()["message"]


def test_model_fetch_no_worker_message_lists_the_real_reason(logged_in_client, monkeypatch):
    """§5.1 row 7: the 400 must say WHY, using `assess`'s own reason strings
    -- "your agent is too old" has to be tellable apart from "nobody has the
    disk for it".

    Final-review I1: at protocol 4 the KIND gate is what refuses now, and it
    refuses before `verdict` is ever consulted, so the reason is
    `model_fetch_protocol:` rather than `missing_models_unverified_protocol:`.
    The distinguishability the row asks for is unchanged -- and the reason is
    now true for a verified entry too, which the entry-keyed one never was."""
    _register_worker(logged_in_client, protocol=4)
    monkeypatch.setattr(model_fetch, "head_size_bytes", lambda url, **k: 335_000_000)
    r = _post(logged_in_client, **BODY)
    assert r.status_code == 400
    assert r.json()["error"] == "model_fetch.no_worker"
    message = r.json()["message"]
    assert "model_fetch_protocol:unknown_vae.safetensors" in message
    # 通用句子仍在前面（zh-TW 先、English 後）。
    assert message.startswith("目前沒有可下載的 worker")


def test_model_fetch_no_worker_message_reports_the_disk_reason(logged_in_client, monkeypatch):
    """A protocol-5 worker that simply hasn't the budget gets a DIFFERENT
    reason than the protocol one -- which is the whole point of listing them."""
    _register_worker(logged_in_client, protocol=5, max_fetch_gb=0.001, free_disk_gb=0.01)
    monkeypatch.setattr(model_fetch, "head_size_bytes", lambda url, **k: 335_000_000)
    r = _post(logged_in_client, **BODY)
    assert r.status_code == 400
    message = r.json()["message"]
    assert "missing_models_unverified_protocol" not in message
    assert "model_fetch_protocol:" not in message
    assert "unknown_vae.safetensors" in message


def test_model_fetch_no_worker_message_is_generic_with_nobody_online(logged_in_client, monkeypatch):
    """No online candidate at all = no per-candidate reason to report; the
    generic sentence stands alone rather than ending in a dangling colon."""
    _register_worker(logged_in_client, protocol=5, status="offline")
    monkeypatch.setattr(model_fetch, "head_size_bytes", lambda url, **k: 335_000_000)
    r = _post(logged_in_client, **BODY)
    assert r.status_code == 400
    assert r.json()["error"] == "model_fetch.no_worker"
    assert not r.json()["message"].rstrip().endswith("：")


@pytest.mark.parametrize("status", ["assigned", "running"])
def test_model_fetch_reuses_an_in_flight_job(logged_in_client, monkeypatch, status):
    """The reuse row covers every live status, not just `queued` -- this
    stack calls the claimed-but-not-started state `assigned`, where the spec
    says `dispatched`."""
    _register_worker(logged_in_client, protocol=5, max_fetch_gb=30)
    monkeypatch.setattr(model_fetch, "head_size_bytes", lambda url, **k: 335_000_000)
    job_id = _post(logged_in_client, **BODY).json()["job_id"]

    with db.get_session() as s:
        s.get(db.Job, job_id).status = status
        s.commit()

    r = _post(logged_in_client, **BODY)
    assert r.status_code == 200
    assert r.json() == {"job_id": job_id, "reused": True}
