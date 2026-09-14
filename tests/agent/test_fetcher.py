"""Agent-side model auto-fetch: signature gate, download/retry/backup,
hash verification, budget/disk checks, path sanitization, cancellation,
and progress throttling.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import re
import time

import httpx
import pytest
from nacl.signing import SigningKey

from comfyfed_agent import fetcher, peerserve
from comfyfed_agent.comfy import JobCancelled
from comfyfed_agent.config import PlatformEntry
from tests.agent.test_peerserve import _make_grant, _platform, _sign_grant


def _keypair():
    signing_key = SigningKey.generate()
    return signing_key, signing_key.verify_key.encode().hex()


def _signed_entry(signing_key, *, name, directory, content, url="http://models.example/f.bin", backup_url=None):
    sha256 = hashlib.sha256(content).hexdigest()
    size_bytes = len(content)
    payload = f"{name}|{directory}|{sha256}|{size_bytes}"
    sig = signing_key.sign(payload.encode()).signature.hex()
    return {
        "name": name,
        "directory": directory,
        "url": url,
        "backup_url": backup_url,
        "sha256": sha256,
        "size_bytes": size_bytes,
        "sig": sig,
    }


class _StreamSpec:
    """One canned `client.stream(...)` outcome: either raises `raise_exc` on
    `__aenter__` (a connect/transport failure) or yields `chunks` and answers
    `status_code` to `raise_for_status`."""

    def __init__(self, chunks=None, status_code=200, raise_exc=None):
        self.chunks = chunks or []
        self.status_code = status_code
        self.raise_exc = raise_exc


class _FakeStreamCtx:
    def __init__(self, spec: _StreamSpec):
        self._spec = spec

    async def __aenter__(self):
        if self._spec.raise_exc is not None:
            raise self._spec.raise_exc
        return self

    async def __aexit__(self, *args):
        return False

    @property
    def is_redirect(self):
        return 300 <= self._spec.status_code < 400

    @property
    def status_code(self):
        return self._spec.status_code

    def raise_for_status(self):
        if self._spec.status_code >= 400:
            request = httpx.Request("GET", "http://models.example/f.bin")
            response = httpx.Response(self._spec.status_code, request=request)
            raise httpx.HTTPStatusError("bad status", request=request, response=response)

    async def aiter_bytes(self, chunk_size):
        for chunk in self._spec.chunks:
            yield chunk


def _client_factory(specs_by_call: list[_StreamSpec], recorded_urls: list):
    """Builds a fake `httpx.AsyncClient` whose `.stream()` pops one
    `_StreamSpec` per call (in call order) and records the URL requested."""

    class _FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        def stream(self, method, url, timeout=None):
            recorded_urls.append(url)
            return _FakeStreamCtx(specs_by_call.pop(0))

    return _FakeAsyncClient


async def _noop_progress(pct, name):
    pass


def _collecting_progress():
    calls = []

    async def _progress(pct, name):
        calls.append((pct, name))

    return _progress, calls


# --- signature verification ------------------------------------------------


async def test_signature_mismatch_aborts_before_any_download(tmp_path):
    signing_key, pubkey_hex = _keypair()
    other_key, _ = _keypair()
    content = b"weights"
    entry = _signed_entry(other_key, name="model.safetensors", directory="checkpoints", content=content)

    with pytest.raises(fetcher.FetchError) as exc_info:
        await fetcher.fetch_and_verify_models(
            entries=[entry],
            platform_pubkey_hex=pubkey_hex,
            models_dir=str(tmp_path),
            max_fetch_gb=100,
            cancel_event=asyncio.Event(),
            report_progress=_noop_progress,
        )

    assert "模型清單簽章驗證失敗" in str(exc_info.value)
    assert "model.safetensors" in str(exc_info.value)
    assert not (tmp_path / "checkpoints").exists()


async def test_one_bad_entry_among_several_aborts_the_whole_batch(tmp_path):
    signing_key, pubkey_hex = _keypair()
    good = _signed_entry(signing_key, name="good.safetensors", directory="checkpoints", content=b"a")
    tampered = _signed_entry(signing_key, name="bad.safetensors", directory="checkpoints", content=b"b")
    tampered["size_bytes"] = tampered["size_bytes"] + 1  # invalidates the signed payload

    with pytest.raises(fetcher.FetchError):
        await fetcher.fetch_and_verify_models(
            entries=[good, tampered],
            platform_pubkey_hex=pubkey_hex,
            models_dir=str(tmp_path),
            max_fetch_gb=100,
            cancel_event=asyncio.Event(),
            report_progress=_noop_progress,
        )

    assert list(tmp_path.rglob("*")) == []  # nothing downloaded, not even the good one


# --- fail-closed entry shape validation (sha256 / size_bytes) ----------------


def _entry_with_raw_fields(signing_key, *, name, directory, sha256, size_bytes, url="http://models.example/f.bin"):
    """Build a manifest entry with attacker/bug-controlled `sha256`/
    `size_bytes` values, still signed correctly over exactly those raw
    values -- so a valid signature can never stand in for a shaped-correctly
    check, isolating the fail-closed entry-shape validation from the
    (already covered) signature-verification gate."""
    payload = f"{name}|{directory}|{sha256}|{size_bytes}"
    sig = signing_key.sign(payload.encode()).signature.hex()
    return {
        "name": name,
        "directory": directory,
        "url": url,
        "backup_url": None,
        "sha256": sha256,
        "size_bytes": size_bytes,
        "sig": sig,
    }


@pytest.mark.parametrize(
    "sha256",
    [
        "",
        None,
        "not-a-valid-hash",
        "ab" * 31,  # 62 hex chars, one short of 64
        "zz" * 32,  # right length, non-hex characters
    ],
)
async def test_malformed_sha256_is_rejected_before_download(tmp_path, sha256):
    signing_key, pubkey_hex = _keypair()
    entry = _entry_with_raw_fields(
        signing_key, name="model.safetensors", directory="checkpoints", sha256=sha256, size_bytes=100
    )

    class _ExplodingClient:
        def __init__(self, *a, **k):
            raise AssertionError("must not even construct a client for a malformed manifest entry")

    with pytest.raises(fetcher.FetchError) as exc_info:
        await fetcher.fetch_and_verify_models(
            entries=[entry],
            platform_pubkey_hex=pubkey_hex,
            models_dir=str(tmp_path),
            max_fetch_gb=100,
            cancel_event=asyncio.Event(),
            report_progress=_noop_progress,
            client_factory=_ExplodingClient,
        )

    assert "模型清單條目無效" in str(exc_info.value)
    assert "model.safetensors" in str(exc_info.value)
    assert list(tmp_path.rglob("*")) == []


@pytest.mark.parametrize("size_bytes", [0, -5, 12.5, True])
async def test_malformed_size_bytes_is_rejected_before_download(tmp_path, size_bytes):
    signing_key, pubkey_hex = _keypair()
    valid_sha256 = hashlib.sha256(b"x").hexdigest()
    entry = _entry_with_raw_fields(
        signing_key,
        name="model.safetensors",
        directory="checkpoints",
        sha256=valid_sha256,
        size_bytes=size_bytes,
    )

    class _ExplodingClient:
        def __init__(self, *a, **k):
            raise AssertionError("must not even construct a client for a malformed manifest entry")

    with pytest.raises(fetcher.FetchError) as exc_info:
        await fetcher.fetch_and_verify_models(
            entries=[entry],
            platform_pubkey_hex=pubkey_hex,
            models_dir=str(tmp_path),
            max_fetch_gb=100,
            cancel_event=asyncio.Event(),
            report_progress=_noop_progress,
            client_factory=_ExplodingClient,
        )

    assert "模型清單條目無效" in str(exc_info.value)
    assert "model.safetensors" in str(exc_info.value)
    assert list(tmp_path.rglob("*")) == []


# --- successful download -----------------------------------------------------


async def test_successful_download_lands_file_and_clears_part(tmp_path, monkeypatch):
    signing_key, pubkey_hex = _keypair()
    content = b"x" * 5000
    entry = _signed_entry(signing_key, name="model.safetensors", directory="checkpoints", content=content)

    recorded = []
    client_cls = _client_factory([_StreamSpec(chunks=[content])], recorded)
    monkeypatch.setattr(fetcher.httpx, "AsyncClient", client_cls)

    await fetcher.fetch_and_verify_models(
        entries=[entry],
        platform_pubkey_hex=pubkey_hex,
        models_dir=str(tmp_path),
        max_fetch_gb=100,
        cancel_event=asyncio.Event(),
        report_progress=_noop_progress,
        client_factory=client_cls,
    )

    final_path = tmp_path / "checkpoints" / "model.safetensors"
    assert final_path.read_bytes() == content
    assert not (tmp_path / "checkpoints" / "model.safetensors.part").exists()
    assert recorded == [entry["url"]]


# --- redirects (C1) -----------------------------------------------------------


async def test_redirect_302_then_200_lands_body_via_follow_redirects(tmp_path):
    """The real official URLs (HuggingFace `/resolve/main/...`, GitHub release
    assets) are 302s. The client must be constructed with
    `follow_redirects=True` so httpx itself chases the redirect chain and the
    real body lands, instead of streaming an empty redirect response into
    `.part` and dying on the size-mismatch branch."""
    signing_key, pubkey_hex = _keypair()
    content = b"redirected-weights"
    entry = _signed_entry(
        signing_key,
        name="model.safetensors",
        directory="checkpoints",
        content=content,
        url="http://models.example/redirect",
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/redirect":
            return httpx.Response(302, headers={"Location": "http://models.example/final"})
        return httpx.Response(200, content=content)

    transport = httpx.MockTransport(handler)
    captured_kwargs = {}

    def client_factory(**kwargs):
        captured_kwargs.update(kwargs)
        return httpx.AsyncClient(transport=transport, **kwargs)

    await fetcher.fetch_and_verify_models(
        entries=[entry],
        platform_pubkey_hex=pubkey_hex,
        models_dir=str(tmp_path),
        max_fetch_gb=100,
        cancel_event=asyncio.Event(),
        report_progress=_noop_progress,
        client_factory=client_factory,
    )

    assert captured_kwargs.get("follow_redirects") is True
    final_path = tmp_path / "checkpoints" / "model.safetensors"
    assert final_path.read_bytes() == content
    assert not (tmp_path / "checkpoints" / "model.safetensors.part").exists()


async def test_redirect_to_invalid_target_fails_cleanly_per_url(tmp_path):
    """A 302 that redirects to a dead target (404) must still fail cleanly --
    named in the error, part file removed -- not hang or silently "succeed"
    with a zero-byte file."""
    signing_key, pubkey_hex = _keypair()
    entry = _signed_entry(
        signing_key,
        name="model.safetensors",
        directory="checkpoints",
        content=b"weights",
        url="http://models.example/redirect",
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/redirect":
            return httpx.Response(302, headers={"Location": "http://models.example/missing"})
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)

    def client_factory(**kwargs):
        return httpx.AsyncClient(transport=transport, **kwargs)

    with pytest.raises(fetcher.FetchError) as exc_info:
        await fetcher.fetch_and_verify_models(
            entries=[entry],
            platform_pubkey_hex=pubkey_hex,
            models_dir=str(tmp_path),
            max_fetch_gb=100,
            cancel_event=asyncio.Event(),
            report_progress=_noop_progress,
            client_factory=client_factory,
        )

    assert entry["url"] in str(exc_info.value)
    assert not (tmp_path / "checkpoints" / "model.safetensors.part").exists()
    assert not (tmp_path / "checkpoints" / "model.safetensors").exists()


# --- hash mismatch -----------------------------------------------------------


async def test_hash_mismatch_deletes_part_and_names_the_file(tmp_path, monkeypatch):
    signing_key, pubkey_hex = _keypair()
    content = b"correct-bytes"
    entry = _signed_entry(signing_key, name="model.safetensors", directory="checkpoints", content=content)

    # Server sends different bytes than what the manifest was signed for --
    # every attempt (2 against the sole url, no backup configured) mismatches.
    wrong_content = b"corrupted!!!!"
    recorded = []
    client_cls = _client_factory(
        [_StreamSpec(chunks=[wrong_content]), _StreamSpec(chunks=[wrong_content])], recorded
    )

    with pytest.raises(fetcher.FetchError) as exc_info:
        await fetcher.fetch_and_verify_models(
            entries=[entry],
            platform_pubkey_hex=pubkey_hex,
            models_dir=str(tmp_path),
            max_fetch_gb=100,
            cancel_event=asyncio.Event(),
            report_progress=_noop_progress,
            client_factory=client_cls,
        )

    assert "model.safetensors" in str(exc_info.value)
    assert not (tmp_path / "checkpoints" / "model.safetensors.part").exists()
    assert not (tmp_path / "checkpoints" / "model.safetensors").exists()


# --- backup url fallback ------------------------------------------------------


async def test_primary_failure_falls_back_to_backup_url(tmp_path, monkeypatch):
    signing_key, pubkey_hex = _keypair()
    content = b"weights-from-backup"
    entry = _signed_entry(
        signing_key,
        name="model.safetensors",
        directory="checkpoints",
        content=content,
        url="http://primary.example/f.bin",
        backup_url="http://backup.example/f.bin",
    )

    recorded = []
    client_cls = _client_factory(
        [
            _StreamSpec(raise_exc=httpx.ConnectTimeout("boom")),  # primary attempt 1
            _StreamSpec(raise_exc=httpx.ConnectTimeout("boom")),  # primary attempt 2 (retry)
            _StreamSpec(chunks=[content]),  # backup attempt 1 succeeds
        ],
        recorded,
    )

    await fetcher.fetch_and_verify_models(
        entries=[entry],
        platform_pubkey_hex=pubkey_hex,
        models_dir=str(tmp_path),
        max_fetch_gb=100,
        cancel_event=asyncio.Event(),
        report_progress=_noop_progress,
        client_factory=client_cls,
    )

    final_path = tmp_path / "checkpoints" / "model.safetensors"
    assert final_path.read_bytes() == content
    assert recorded == [entry["url"], entry["url"], entry["backup_url"]]


async def test_both_urls_exhausted_names_every_url_tried(tmp_path):
    signing_key, pubkey_hex = _keypair()
    content = b"weights"
    entry = _signed_entry(
        signing_key,
        name="model.safetensors",
        directory="checkpoints",
        content=content,
        url="http://primary.example/f.bin",
        backup_url="http://backup.example/f.bin",
    )

    recorded = []
    client_cls = _client_factory(
        [
            _StreamSpec(raise_exc=httpx.ConnectTimeout("boom")),
            _StreamSpec(raise_exc=httpx.ConnectTimeout("boom")),
            _StreamSpec(raise_exc=httpx.ConnectTimeout("boom")),
            _StreamSpec(raise_exc=httpx.ConnectTimeout("boom")),
        ],
        recorded,
    )

    with pytest.raises(fetcher.FetchError) as exc_info:
        await fetcher.fetch_and_verify_models(
            entries=[entry],
            platform_pubkey_hex=pubkey_hex,
            models_dir=str(tmp_path),
            max_fetch_gb=100,
            cancel_event=asyncio.Event(),
            report_progress=_noop_progress,
            client_factory=client_cls,
        )

    message = str(exc_info.value)
    assert entry["url"] in message
    assert entry["backup_url"] in message
    assert not (tmp_path / "checkpoints" / "model.safetensors.part").exists()


# --- cancellation --------------------------------------------------------------


async def test_cancel_mid_download_raises_job_cancelled_and_deletes_part(tmp_path):
    signing_key, pubkey_hex = _keypair()
    content = b"a" * (fetcher._CHUNK_SIZE * 3)
    entry = _signed_entry(signing_key, name="model.safetensors", directory="checkpoints", content=content)

    cancel_event = asyncio.Event()
    recorded = []

    # Trip the cancel event once the first chunk has been written, from
    # inside the progress callback -- simulating a job_cancelled/shutdown
    # arriving mid-stream.
    async def _progress(pct, name):
        cancel_event.set()

    chunks = [content[: fetcher._CHUNK_SIZE], content[fetcher._CHUNK_SIZE : 2 * fetcher._CHUNK_SIZE], content[2 * fetcher._CHUNK_SIZE :]]
    client_cls = _client_factory([_StreamSpec(chunks=chunks)], recorded)

    with pytest.raises(JobCancelled):
        await fetcher.fetch_and_verify_models(
            entries=[entry],
            platform_pubkey_hex=pubkey_hex,
            models_dir=str(tmp_path),
            max_fetch_gb=100,
            cancel_event=cancel_event,
            report_progress=_progress,
            client_factory=client_cls,
        )

    assert not (tmp_path / "checkpoints" / "model.safetensors.part").exists()
    assert not (tmp_path / "checkpoints" / "model.safetensors").exists()


async def test_already_cancelled_before_start_raises_without_any_request(tmp_path):
    signing_key, pubkey_hex = _keypair()
    entry = _signed_entry(signing_key, name="model.safetensors", directory="checkpoints", content=b"x")

    cancel_event = asyncio.Event()
    cancel_event.set()

    class _ExplodingClient:
        def __init__(self, *a, **k):
            raise AssertionError("must not even construct a client once cancelled")

    with pytest.raises(JobCancelled):
        await fetcher.fetch_and_verify_models(
            entries=[entry],
            platform_pubkey_hex=pubkey_hex,
            models_dir=str(tmp_path),
            max_fetch_gb=100,
            cancel_event=cancel_event,
            report_progress=_noop_progress,
            client_factory=_ExplodingClient,
        )


# --- budget / disk -------------------------------------------------------------


async def test_total_size_over_max_fetch_gb_refuses_before_download(tmp_path):
    signing_key, pubkey_hex = _keypair()
    big_content_len = 2 * 1024 ** 3  # 2 GB, but we don't actually allocate the bytes
    entry = _signed_entry(signing_key, name="model.safetensors", directory="checkpoints", content=b"x")
    entry["size_bytes"] = big_content_len
    # Re-sign with the inflated size_bytes so signature verification passes
    # and the budget check is what actually fires.
    payload = f"{entry['name']}|{entry['directory']}|{entry['sha256']}|{entry['size_bytes']}"
    entry["sig"] = signing_key.sign(payload.encode()).signature.hex()

    with pytest.raises(fetcher.FetchError) as exc_info:
        await fetcher.fetch_and_verify_models(
            entries=[entry],
            platform_pubkey_hex=pubkey_hex,
            models_dir=str(tmp_path),
            max_fetch_gb=1,  # 1 GB budget, 2 GB requested
            cancel_event=asyncio.Event(),
            report_progress=_noop_progress,
        )

    assert "超過設定上限" in str(exc_info.value) or "exceeds" in str(exc_info.value)
    assert list(tmp_path.rglob("*")) == []


async def test_insufficient_free_disk_refuses_before_download(tmp_path, monkeypatch):
    signing_key, pubkey_hex = _keypair()
    entry = _signed_entry(signing_key, name="model.safetensors", directory="checkpoints", content=b"x" * 1000)

    class _FakeUsage:
        free = 10  # far less than 1000 bytes

    monkeypatch.setattr(fetcher.shutil, "disk_usage", lambda path: _FakeUsage())

    with pytest.raises(fetcher.FetchError) as exc_info:
        await fetcher.fetch_and_verify_models(
            entries=[entry],
            platform_pubkey_hex=pubkey_hex,
            models_dir=str(tmp_path),
            max_fetch_gb=100,
            cancel_event=asyncio.Event(),
            report_progress=_noop_progress,
        )

    assert "磁碟空間不足" in str(exc_info.value) or "disk space" in str(exc_info.value)


# --- path sanitization -----------------------------------------------------------


@pytest.mark.parametrize("bad_directory", ["../../etc", "/etc", "C:\\Windows", "..\\..\\Windows"])
async def test_unsafe_directory_is_rejected(tmp_path, bad_directory):
    signing_key, pubkey_hex = _keypair()
    entry = _signed_entry(signing_key, name="model.safetensors", directory=bad_directory, content=b"x")

    with pytest.raises(fetcher.FetchError):
        await fetcher.fetch_and_verify_models(
            entries=[entry],
            platform_pubkey_hex=pubkey_hex,
            models_dir=str(tmp_path),
            max_fetch_gb=100,
            cancel_event=asyncio.Event(),
            report_progress=_noop_progress,
        )


@pytest.mark.parametrize(
    "bad_name", ["../evil.bin", "..", ".", "/etc/passwd", "sub/name.bin", "model.bin:hidden"]
)
async def test_unsafe_name_is_rejected(tmp_path, bad_name):
    signing_key, pubkey_hex = _keypair()
    entry = _signed_entry(signing_key, name=bad_name, directory="checkpoints", content=b"x")

    with pytest.raises(fetcher.FetchError):
        await fetcher.fetch_and_verify_models(
            entries=[entry],
            platform_pubkey_hex=pubkey_hex,
            models_dir=str(tmp_path),
            max_fetch_gb=100,
            cancel_event=asyncio.Event(),
            report_progress=_noop_progress,
        )


# --- progress throttling -----------------------------------------------------------


async def test_progress_reports_overall_percent_weighted_by_size(tmp_path, monkeypatch):
    signing_key, pubkey_hex = _keypair()
    small_content = b"a" * 100
    big_content = b"b" * 900
    small = _signed_entry(signing_key, name="small.bin", directory="checkpoints", content=small_content)
    big = _signed_entry(signing_key, name="big.bin", directory="checkpoints", content=big_content)

    recorded = []
    client_cls = _client_factory(
        [_StreamSpec(chunks=[small_content]), _StreamSpec(chunks=[big_content])], recorded
    )

    progress_cb, calls = _collecting_progress()

    # Force every chunk to report (bypass the time/pct throttle) by
    # monkeypatching the throttle constants down to zero.
    monkeypatch.setattr(fetcher, "_PROGRESS_MIN_INTERVAL_SECONDS", 0.0)
    monkeypatch.setattr(fetcher, "_PROGRESS_MIN_PCT_STEP", 0.0)

    await fetcher.fetch_and_verify_models(
        entries=[small, big],
        platform_pubkey_hex=pubkey_hex,
        models_dir=str(tmp_path),
        max_fetch_gb=100,
        cancel_event=asyncio.Event(),
        report_progress=progress_cb,
        client_factory=client_cls,
    )

    assert calls, "expected at least one progress report"
    percents = [pct for pct, _name in calls]
    assert percents == sorted(percents)  # monotonically non-decreasing
    assert percents[-1] == 100.0
    # The small file finishing should report ~10% (100 of 1000 total bytes).
    assert any(abs(pct - 10.0) < 0.01 for pct, name in calls if name == "small.bin")
    # Final call signals completion with no specific model name.
    assert calls[-1] == (100.0, None)


async def test_progress_is_throttled_by_default(tmp_path):
    signing_key, pubkey_hex = _keypair()
    # 1000 tiny chunks, each well under a 5% step (0.1% of the total) and
    # all landing in well under 2 seconds of wall time -- without the
    # throttle this would be 1000 progress reports.
    chunks = [b"x" for _ in range(1000)]
    total = b"".join(chunks)
    entry = _signed_entry(signing_key, name="model.bin", directory="checkpoints", content=total)

    recorded = []
    client_cls = _client_factory([_StreamSpec(chunks=chunks)], recorded)
    progress_cb, calls = _collecting_progress()

    await fetcher.fetch_and_verify_models(
        entries=[entry],
        platform_pubkey_hex=pubkey_hex,
        models_dir=str(tmp_path),
        max_fetch_gb=100,
        cancel_event=asyncio.Event(),
        report_progress=progress_cb,
        client_factory=client_cls,
    )

    # The default 2-second/5% throttle collapses 1000 chunk-completions down
    # to a small handful of reports, always ending on the 100% completion.
    assert 0 < len(calls) < 30
    assert calls[-1] == (100.0, None)


# --- Phase 3.1 P2P addendum: peer source path --------------------------------


def _puller_platform_entry(worker_id="puller-1"):
    """A puller agent's own pinned-platform entry -- what fetcher signs its
    `/api/agent/peer-grant` REQUEST with. Unrelated to the seeder identity
    `tests.agent.test_peerserve._platform` builds (that one signs the GRANT
    itself, verified seeder-side by `peerserve`, which this module never
    touches -- fetcher only forwards whatever the platform handed it)."""
    signing_key = SigningKey.generate()
    return PlatformEntry(
        platform_url="http://platform.example",
        platform_pubkey="0" * 64,  # unused: fetcher never verifies the grant itself
        worker_id=worker_id,
        certificate="cert",
        signing_key_hex=signing_key.encode().hex(),
    )


class _FakePlatformClient:
    """Fakes the `httpx.AsyncClient` fetcher uses for `POST
    /api/agent/peer-grant` -- `handler(path, content, headers)` returns the
    canned `httpx.Response`."""

    def __init__(self, handler, **_kwargs):
        self._handler = handler

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, path, content=None, headers=None):
        return self._handler(path, content, headers)


def _platform_client_factory(handler):
    def _factory(**kwargs):
        return _FakePlatformClient(handler)

    return _factory


class _ExplodingURLClient:
    """The URL-chain `client_factory` for a test expecting the peer source
    to fully satisfy every entry -- construction is fine (the outer `async
    with client_factory(...)` always runs it once), but `.stream()` must
    never be called."""

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    def stream(self, *a, **k):
        raise AssertionError("peer source should have satisfied the entry; URL chain must not run")


def _grant_issuer(*, name, size_bytes, seeder_id, signing_key, peer_url, chunk_sha256s):
    """A fake `/api/agent/peer-grant` handler that mints a freshly-signed,
    freshly-numbered (`g-1`, `g-2`, ...) grant on every call -- `.calls`
    counts invocations, useful for asserting a single grant vs. a re-grant."""

    state = {"calls": 0}

    def handle(path, content, headers):
        state["calls"] += 1
        grant = _make_grant(
            name=name, size_bytes=size_bytes, seeder_id=seeder_id, puller_id="puller-1",
            grant_id=f"g-{state['calls']}",
        )
        sig = _sign_grant(signing_key, grant)
        return httpx.Response(
            200,
            json={"grant": {**grant, "sig": sig}, "peer_url": peer_url, "chunk_sha256s": chunk_sha256s},
        )

    handle.calls = lambda: state["calls"]
    return handle


def _chunk_sha256s(content: bytes, chunk_size: int) -> list[str]:
    return [
        hashlib.sha256(content[i : i + chunk_size]).hexdigest() for i in range(0, len(content), chunk_size)
    ]


async def test_peer_happy_path_multi_chunk_pull(tmp_path, monkeypatch):
    """Peer source satisfies the entry entirely: multiple chunks (small
    monkeypatched chunk size), verified individually, land + whole-file
    verify + atomic replace -- the URL chain is never touched."""
    monkeypatch.setattr(fetcher, "_PEER_CHUNK_SIZE", 1000)

    content = os.urandom(5000)
    seed_dir = tmp_path / "seed"
    (seed_dir / "checkpoints").mkdir(parents=True)
    (seed_dir / "checkpoints" / "model.bin").write_bytes(content)

    seeder_signing_key, seeder_entry = _platform(worker_id="seeder-1")
    srv = peerserve.PeerHTTPServer(
        models_dir=str(seed_dir), port=0, platforms=[seeder_entry], bind_host="127.0.0.1"
    )
    srv.start()
    try:
        manifest_key, manifest_pubkey_hex = _keypair()
        entry = _signed_entry(
            manifest_key, name="model.bin", directory="checkpoints", content=content,
            url="http://models.example/should-not-be-fetched",
        )

        issuer = _grant_issuer(
            name="checkpoints/model.bin", size_bytes=len(content), seeder_id=seeder_entry.worker_id,
            signing_key=seeder_signing_key, peer_url=f"http://127.0.0.1:{srv.port}",
            chunk_sha256s=_chunk_sha256s(content, 1000),
        )

        dest = tmp_path / "dest"
        await fetcher.fetch_and_verify_models(
            entries=[entry],
            platform_pubkey_hex=manifest_pubkey_hex,
            models_dir=str(dest),
            max_fetch_gb=100,
            cancel_event=asyncio.Event(),
            report_progress=_noop_progress,
            client_factory=_ExplodingURLClient,
            platform_entry=_puller_platform_entry(),
            peer_client_factory=httpx.AsyncClient,
            platform_client_factory=_platform_client_factory(issuer),
        )

        final_path = dest / "checkpoints" / "model.bin"
        assert final_path.read_bytes() == content
        assert not (dest / "checkpoints" / "model.bin.part").exists()
        assert issuer.calls() == 1
    finally:
        srv.stop()


async def test_peer_chunk_mismatch_falls_back_to_url(tmp_path, monkeypatch):
    """A per-chunk hash mismatch abandons the peer source entirely (`.part`
    cleared, no retry against the peer) and falls to the URL chain, which
    completes normally."""
    monkeypatch.setattr(fetcher, "_PEER_CHUNK_SIZE", 1000)

    content = os.urandom(3000)
    seed_dir = tmp_path / "seed"
    (seed_dir / "checkpoints").mkdir(parents=True)
    (seed_dir / "checkpoints" / "model.bin").write_bytes(content)

    seeder_signing_key, seeder_entry = _platform(worker_id="seeder-1")
    srv = peerserve.PeerHTTPServer(
        models_dir=str(seed_dir), port=0, platforms=[seeder_entry], bind_host="127.0.0.1"
    )
    srv.start()
    try:
        manifest_key, manifest_pubkey_hex = _keypair()
        entry = _signed_entry(
            manifest_key, name="model.bin", directory="checkpoints", content=content,
            url="http://models.example/f.bin",
        )

        bad_chunks = _chunk_sha256s(content, 1000)
        bad_chunks[1] = "0" * 64  # corrupt the second chunk's expected hash

        issuer = _grant_issuer(
            name="checkpoints/model.bin", size_bytes=len(content), seeder_id=seeder_entry.worker_id,
            signing_key=seeder_signing_key, peer_url=f"http://127.0.0.1:{srv.port}",
            chunk_sha256s=bad_chunks,
        )

        recorded = []
        url_client_cls = _client_factory([_StreamSpec(chunks=[content])], recorded)

        dest = tmp_path / "dest"
        await fetcher.fetch_and_verify_models(
            entries=[entry],
            platform_pubkey_hex=manifest_pubkey_hex,
            models_dir=str(dest),
            max_fetch_gb=100,
            cancel_event=asyncio.Event(),
            report_progress=_noop_progress,
            client_factory=url_client_cls,
            platform_entry=_puller_platform_entry(),
            peer_client_factory=httpx.AsyncClient,
            platform_client_factory=_platform_client_factory(issuer),
        )

        final_path = dest / "checkpoints" / "model.bin"
        assert final_path.read_bytes() == content
        assert not (dest / "checkpoints" / "model.bin.part").exists()
        assert recorded == [entry["url"]]
        assert issuer.calls() == 1  # peer tried exactly once, no retry loop after a mismatch
    finally:
        srv.stop()


async def test_peer_resume_after_disconnect_regrants_and_skips_verified_chunks(tmp_path, monkeypatch):
    """A mid-transfer disconnect (simulated as a 403 on the in-flight chunk,
    matching a seeder-side grant-expiry response) triggers a fresh grant;
    the resume logic re-verifies `.part` against `chunk_sha256s` and
    continues from the first missing chunk -- the already-verified chunk is
    never re-requested."""
    monkeypatch.setattr(fetcher, "_PEER_CHUNK_SIZE", 1000)

    content = os.urandom(3000)
    chunk_sha256s = _chunk_sha256s(content, 1000)
    inventory_name = "checkpoints/model.bin"

    requests: list[tuple[str, str]] = []
    # The chunk starting at byte 1000, but ONLY under the first grant, fails
    # with 403 -- simulating a disconnect/expiry mid-pull; a fresh grant
    # (g-2) succeeds for that same range.
    failing = {("g-1", 1000)}

    class _FakePeerServer:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, headers=None):
            grant_obj = json.loads(base64.b64decode(headers[fetcher._PEER_GRANT_HEADER]))
            grant_id = grant_obj["grant_id"]
            m = re.match(r"bytes=(\d+)-(\d+)", headers["Range"])
            start, end = int(m.group(1)), int(m.group(2))
            requests.append((grant_id, headers["Range"]))
            if (grant_id, start) in failing:
                return httpx.Response(403, content=b"")
            return httpx.Response(206, content=content[start : end + 1])

    def _peer_client_factory(**kwargs):
        return _FakePeerServer()

    seeder_signing_key, seeder_entry = _platform(worker_id="seeder-1")
    issuer = _grant_issuer(
        name=inventory_name, size_bytes=len(content), seeder_id=seeder_entry.worker_id,
        signing_key=seeder_signing_key, peer_url="http://fake-peer.example",
        chunk_sha256s=chunk_sha256s,
    )

    manifest_key, manifest_pubkey_hex = _keypair()
    entry = _signed_entry(
        manifest_key, name="model.bin", directory="checkpoints", content=content,
        url="http://models.example/should-not-be-fetched",
    )

    dest = tmp_path / "dest"
    await fetcher.fetch_and_verify_models(
        entries=[entry],
        platform_pubkey_hex=manifest_pubkey_hex,
        models_dir=str(dest),
        max_fetch_gb=100,
        cancel_event=asyncio.Event(),
        report_progress=_noop_progress,
        client_factory=_ExplodingURLClient,
        platform_entry=_puller_platform_entry(),
        peer_client_factory=_peer_client_factory,
        platform_client_factory=_platform_client_factory(issuer),
    )

    final_path = dest / "checkpoints" / "model.bin"
    assert final_path.read_bytes() == content
    assert issuer.calls() == 2  # one re-grant after the simulated disconnect

    # Chunk 0 (bytes=0-999) was verified under g-1 and must NEVER be
    # re-requested once g-2 takes over.
    chunk0_requests = [r for r in requests if r[1] == "bytes=0-999"]
    assert chunk0_requests == [("g-1", "bytes=0-999")]

    # The failed range was retried, successfully, under the fresh grant.
    assert ("g-1", "bytes=1000-1999") in requests
    assert ("g-2", "bytes=1000-1999") in requests


async def test_peer_always_403_falls_back_after_no_progress_cap(tmp_path):
    """A seeder that always 403s (grant expiry that never resolves, even
    across re-grants) must not loop forever: after
    `fetcher._MAX_NO_PROGRESS_REGRANTS` re-grants that make no forward
    progress, the peer source is abandoned and the URL chain runs. Request
    accounting proves the exact cap, not just "it terminated"."""
    content = b"weights" * 50
    inventory_name = "checkpoints/model.bin"

    peer_requests: list[str] = []  # grant_id per attempted pull

    class _AlwaysFailingPeerServer:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, headers=None):
            grant_obj = json.loads(base64.b64decode(headers[fetcher._PEER_GRANT_HEADER]))
            peer_requests.append(grant_obj["grant_id"])
            return httpx.Response(403, content=b"")

    def _peer_client_factory(**kwargs):
        return _AlwaysFailingPeerServer()

    seeder_signing_key, seeder_entry = _platform(worker_id="seeder-1")
    issuer = _grant_issuer(
        name=inventory_name, size_bytes=len(content), seeder_id=seeder_entry.worker_id,
        signing_key=seeder_signing_key, peer_url="http://fake-peer.example",
        chunk_sha256s=None,  # no per-chunk list -- offset is always 0, so every re-grant is "no progress"
    )

    manifest_key, manifest_pubkey_hex = _keypair()
    entry = _signed_entry(
        manifest_key, name="model.bin", directory="checkpoints", content=content,
        url="http://models.example/f.bin",
    )

    recorded = []
    url_client_cls = _client_factory([_StreamSpec(chunks=[content])], recorded)

    dest = tmp_path / "dest"
    await fetcher.fetch_and_verify_models(
        entries=[entry],
        platform_pubkey_hex=manifest_pubkey_hex,
        models_dir=str(dest),
        max_fetch_gb=100,
        cancel_event=asyncio.Event(),
        report_progress=_noop_progress,
        client_factory=url_client_cls,
        platform_entry=_puller_platform_entry(),
        peer_client_factory=_peer_client_factory,
        platform_client_factory=_platform_client_factory(issuer),
    )

    final_path = dest / "checkpoints" / "model.bin"
    assert final_path.read_bytes() == content  # URL chain fallback succeeded
    assert recorded == [entry["url"]]

    # Exactly _MAX_NO_PROGRESS_REGRANTS pull attempts were made against the
    # peer (one per grant, each 403ing), plus the initial + that many
    # re-grants issued -- proving the loop actually stopped at the cap
    # rather than retrying forever or bailing early/late.
    assert len(peer_requests) == fetcher._MAX_NO_PROGRESS_REGRANTS
    assert peer_requests == [f"g-{i}" for i in range(1, fetcher._MAX_NO_PROGRESS_REGRANTS + 1)]
    assert issuer.calls() == fetcher._MAX_NO_PROGRESS_REGRANTS + 1


async def test_peer_only_entry_failure_is_fetch_failure(tmp_path):
    """A `url: None, peer: True` entry skips the URL chain entirely -- a
    failed peer grant for it is a plain fetch failure, not a silent
    fall-through."""
    manifest_key, manifest_pubkey_hex = _keypair()
    content = b"x" * 100
    entry = _signed_entry(
        manifest_key, name="model.bin", directory="checkpoints", content=content, url=None
    )
    entry["peer"] = True

    def _no_seeder(path, content, headers):
        request = httpx.Request("POST", "http://platform.example" + path)
        return httpx.Response(404, json={"detail": {"code": "peer.no_seeder"}}, request=request)

    with pytest.raises(fetcher.FetchError) as exc_info:
        await fetcher.fetch_and_verify_models(
            entries=[entry],
            platform_pubkey_hex=manifest_pubkey_hex,
            models_dir=str(tmp_path),
            max_fetch_gb=100,
            cancel_event=asyncio.Event(),
            report_progress=_noop_progress,
            client_factory=_ExplodingURLClient,
            platform_entry=_puller_platform_entry(),
            peer_client_factory=httpx.AsyncClient,
            platform_client_factory=_platform_client_factory(_no_seeder),
        )

    assert "model.bin" in str(exc_info.value)
    assert not (tmp_path / "checkpoints" / "model.bin").exists()
    assert not (tmp_path / "checkpoints" / "model.bin.part").exists()


async def test_cancel_mid_peer_pull_cleans_up(tmp_path, monkeypatch):
    """Cancellation mid peer-pull raises JobCancelled and removes the
    `.part` -- the same contract the URL path already guarantees, reused
    unchanged."""
    monkeypatch.setattr(fetcher, "_PEER_CHUNK_SIZE", 1000)
    monkeypatch.setattr(fetcher, "_PROGRESS_MIN_INTERVAL_SECONDS", 0.0)
    monkeypatch.setattr(fetcher, "_PROGRESS_MIN_PCT_STEP", 0.0)

    content = os.urandom(5000)
    seed_dir = tmp_path / "seed"
    (seed_dir / "checkpoints").mkdir(parents=True)
    (seed_dir / "checkpoints" / "model.bin").write_bytes(content)

    seeder_signing_key, seeder_entry = _platform(worker_id="seeder-1")
    srv = peerserve.PeerHTTPServer(
        models_dir=str(seed_dir), port=0, platforms=[seeder_entry], bind_host="127.0.0.1"
    )
    srv.start()
    try:
        manifest_key, manifest_pubkey_hex = _keypair()
        entry = _signed_entry(
            manifest_key, name="model.bin", directory="checkpoints", content=content,
            url="http://models.example/should-not-be-fetched",
        )
        issuer = _grant_issuer(
            name="checkpoints/model.bin", size_bytes=len(content), seeder_id=seeder_entry.worker_id,
            signing_key=seeder_signing_key, peer_url=f"http://127.0.0.1:{srv.port}",
            chunk_sha256s=_chunk_sha256s(content, 1000),
        )

        cancel_event = asyncio.Event()

        async def _progress(pct, name):
            cancel_event.set()

        dest = tmp_path / "dest"
        with pytest.raises(JobCancelled):
            await fetcher.fetch_and_verify_models(
                entries=[entry],
                platform_pubkey_hex=manifest_pubkey_hex,
                models_dir=str(dest),
                max_fetch_gb=100,
                cancel_event=cancel_event,
                report_progress=_progress,
                client_factory=_ExplodingURLClient,
                platform_entry=_puller_platform_entry(),
                peer_client_factory=httpx.AsyncClient,
                platform_client_factory=_platform_client_factory(issuer),
            )

        assert not (dest / "checkpoints" / "model.bin.part").exists()
        assert not (dest / "checkpoints" / "model.bin").exists()
    finally:
        srv.stop()
