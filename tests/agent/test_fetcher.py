"""Agent-side model auto-fetch: signature gate, download/retry/backup,
hash verification, budget/disk checks, path sanitization, cancellation,
and progress throttling.
"""

from __future__ import annotations

import asyncio
import hashlib
import os

import httpx
import pytest
from nacl.signing import SigningKey

from comfyfed_agent import fetcher
from comfyfed_agent.comfy import JobCancelled


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


@pytest.mark.parametrize("bad_name", ["../evil.bin", "..", ".", "/etc/passwd", "sub/name.bin"])
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
