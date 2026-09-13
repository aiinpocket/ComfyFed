"""Agent-side model inventory units and config-file hardening."""

import hashlib
import json
import os
import stat
import threading
import time

from comfyfed_agent import hardware
from comfyfed_agent.config import AgentConfig, PlatformEntry


def test_scan_models_reports_sizes_in_gigabytes(tmp_path):
    models_dir = tmp_path / "models"
    (models_dir / "checkpoints").mkdir(parents=True)
    big = models_dir / "checkpoints" / "sd_xl_base.safetensors"
    big.write_bytes(b"\0" * (3 * 1024 * 1024))  # 3 MiB

    entries = hardware.scan_models(str(models_dir))
    assert len(entries) == 1
    entry = entries[0]

    assert entry["name"] == "checkpoints/sd_xl_base.safetensors"
    # 3 MiB in GB, not 3145728 bytes.
    assert entry["size"] == round(3 * 1024 * 1024 / (1024 ** 3), 3)
    assert entry["size"] < 1


def test_scan_models_returns_empty_for_missing_dir(tmp_path):
    assert hardware.scan_models(str(tmp_path / "nope")) == []


def test_comfy_output_and_input_dir_round_trip_through_save_and_load(tmp_path):
    path = tmp_path / "agent.json"
    config = AgentConfig(comfy_output_dir=str(tmp_path / "output"), comfy_input_dir=str(tmp_path / "input"))
    config.save(str(path))

    loaded = AgentConfig.load(str(path))
    assert loaded.comfy_output_dir == str(tmp_path / "output")
    assert loaded.comfy_input_dir == str(tmp_path / "input")


def test_comfy_output_and_input_dir_default_to_none(tmp_path):
    path = tmp_path / "agent.json"
    AgentConfig().save(str(path))

    loaded = AgentConfig.load(str(path))
    assert loaded.comfy_output_dir is None
    assert loaded.comfy_input_dir is None


def _wait_for_hash(models_dir, rel_path, timeout=5.0):
    """Poll the sidecar cache until `rel_path` has a sha256, or time out."""
    cache_path = os.path.join(str(models_dir), ".comfyfed_hashes.json")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                cache = json.load(f)
        except (OSError, json.JSONDecodeError):
            cache = {}
        if rel_path in cache and cache[rel_path].get("sha256"):
            return cache[rel_path]["sha256"]
        time.sleep(0.02)
    raise AssertionError(f"{rel_path} was never hashed within {timeout}s")


def test_scan_models_lazily_hashes_and_caches_sha256(tmp_path):
    models_dir = tmp_path / "models"
    models_dir.mkdir()
    (models_dir / "a.bin").write_bytes(b"hello world")
    expected = hashlib.sha256(b"hello world").hexdigest()

    # First pass schedules the hash in the background; it isn't necessarily
    # present yet.
    hardware.scan_models(str(models_dir))
    _wait_for_hash(models_dir, "a.bin")

    entries = hardware.scan_models(str(models_dir))
    assert entries[0]["sha256"] == expected


def test_scan_models_cached_hit_does_not_reread_unchanged_file(tmp_path, monkeypatch):
    models_dir = tmp_path / "models"
    models_dir.mkdir()
    (models_dir / "a.bin").write_bytes(b"hello world")

    hardware.scan_models(str(models_dir))
    _wait_for_hash(models_dir, "a.bin")

    calls = []
    real = hardware._hash_file_sha256

    def counting(path):
        calls.append(path)
        return real(path)

    monkeypatch.setattr(hardware, "_hash_file_sha256", counting)

    for _ in range(3):
        entries = hardware.scan_models(str(models_dir))
        assert entries[0]["sha256"]

    time.sleep(0.1)
    assert calls == []  # unchanged (size, mtime) -> cache hit, no re-read


def test_scan_models_schedules_at_most_one_unhashed_file_per_pass(tmp_path, monkeypatch):
    models_dir = tmp_path / "models"
    models_dir.mkdir()
    (models_dir / "small.bin").write_bytes(b"a" * 10)
    (models_dir / "big.bin").write_bytes(b"b" * 1000)

    started = threading.Event()
    release = threading.Event()
    calls = []

    def blocking_hash(path):
        calls.append(path)
        started.set()
        release.wait(timeout=5)
        return hashlib.sha256(b"x").hexdigest()

    monkeypatch.setattr(hardware, "_hash_file_sha256", blocking_hash)

    hardware.scan_models(str(models_dir))
    assert started.wait(timeout=2), "expected a hash to be scheduled"
    time.sleep(0.1)

    assert len(calls) == 1
    # Deterministic pick: smallest file first, so cheap models converge
    # immediately instead of queueing behind a large one.
    assert calls[0].endswith("small.bin")

    # A second scan while the first hash is still in flight must not
    # schedule a second thread for the other candidate.
    hardware.scan_models(str(models_dir))
    time.sleep(0.1)
    assert len(calls) == 1

    release.set()
    _wait_for_hash(models_dir, "small.bin")


def test_scan_models_mtime_change_invalidates_cache(tmp_path, monkeypatch):
    models_dir = tmp_path / "models"
    models_dir.mkdir()
    path = models_dir / "a.bin"
    path.write_bytes(b"version one")

    hardware.scan_models(str(models_dir))
    first_hash = _wait_for_hash(models_dir, "a.bin")

    calls = []
    real = hardware._hash_file_sha256

    def counting(p):
        calls.append(p)
        return real(p)

    monkeypatch.setattr(hardware, "_hash_file_sha256", counting)

    # Change content AND bump mtime forward so the cache is treated as stale
    # even on filesystems with coarse mtime resolution.
    new_mtime = os.path.getmtime(path) + 5
    path.write_bytes(b"version two, much longer content than before")
    os.utime(path, (new_mtime, new_mtime))

    hardware.scan_models(str(models_dir))
    assert len(calls) == 1  # rehash was scheduled

    second_hash = _wait_for_hash(models_dir, "a.bin")
    # _wait_for_hash may see the stale cached hash if it wins a race with
    # the background thread, so wait for it to actually change.
    deadline = time.monotonic() + 5.0
    while second_hash == first_hash and time.monotonic() < deadline:
        time.sleep(0.02)
        second_hash = _wait_for_hash(models_dir, "a.bin")
    assert second_hash != first_hash


def test_scan_models_hash_models_false_disables_hashing(tmp_path, monkeypatch):
    models_dir = tmp_path / "models"
    models_dir.mkdir()
    (models_dir / "a.bin").write_bytes(b"hello world")

    def fail_hash(path):
        raise AssertionError("hashing must not run when hash_models=False")

    monkeypatch.setattr(hardware, "_hash_file_sha256", fail_hash)

    entries = hardware.scan_models(str(models_dir), hash_models=False)
    assert "sha256" not in entries[0]

    time.sleep(0.1)
    cache_path = os.path.join(str(models_dir), ".comfyfed_hashes.json")
    assert not os.path.exists(cache_path)


def test_scan_models_sidecar_cache_file_is_not_reported_as_a_model(tmp_path):
    models_dir = tmp_path / "models"
    models_dir.mkdir()
    (models_dir / "a.bin").write_bytes(b"hello world")

    hardware.scan_models(str(models_dir))
    _wait_for_hash(models_dir, "a.bin")

    entries = hardware.scan_models(str(models_dir))
    names = {e["name"] for e in entries}
    assert ".comfyfed_hashes.json" not in names


def test_scan_models_tolerates_corrupt_cache_file(tmp_path):
    models_dir = tmp_path / "models"
    models_dir.mkdir()
    (models_dir / "a.bin").write_bytes(b"hello world")
    cache_path = models_dir / ".comfyfed_hashes.json"
    cache_path.write_text("{not valid json", encoding="utf-8")

    # Must not raise -- start fresh instead.
    entries = hardware.scan_models(str(models_dir))
    assert entries[0]["name"] == "a.bin"

    _wait_for_hash(models_dir, "a.bin")


def test_scan_models_prunes_sidecar_entries_for_deleted_files(tmp_path):
    models_dir = tmp_path / "models"
    models_dir.mkdir()
    keep = models_dir / "keep.bin"
    gone = models_dir / "gone.bin"
    keep.write_bytes(b"keep me")
    gone.write_bytes(b"delete me")

    # Only one hash is scheduled per pass, so rescan until both converge.
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        hardware.scan_models(str(models_dir))
        cache_path = models_dir / ".comfyfed_hashes.json"
        try:
            cache = json.loads(cache_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            cache = {}
        if "keep.bin" in cache and "gone.bin" in cache:
            break
        time.sleep(0.05)
    else:
        raise AssertionError("keep.bin and gone.bin were never both hashed")

    cache_path = models_dir / ".comfyfed_hashes.json"
    cache = json.loads(cache_path.read_text(encoding="utf-8"))
    assert set(cache) == {"keep.bin", "gone.bin"}

    os.remove(gone)
    hardware.scan_models(str(models_dir))

    cache = json.loads(cache_path.read_text(encoding="utf-8"))
    assert set(cache) == {"keep.bin"}


def test_scan_models_prune_is_a_noop_when_hash_models_false(tmp_path):
    models_dir = tmp_path / "models"
    models_dir.mkdir()
    gone = models_dir / "gone.bin"
    gone.write_bytes(b"delete me")

    hardware.scan_models(str(models_dir))
    _wait_for_hash(models_dir, "gone.bin")

    os.remove(gone)
    # A hash_models=False pass must not touch the sidecar at all.
    cache_path = models_dir / ".comfyfed_hashes.json"
    before = cache_path.read_text(encoding="utf-8")
    hardware.scan_models(str(models_dir), hash_models=False)
    after = cache_path.read_text(encoding="utf-8")
    assert before == after


def test_config_hash_models_and_fetch_defaults(tmp_path):
    path = tmp_path / "agent.json"
    AgentConfig().save(str(path))

    loaded = AgentConfig.load(str(path))
    assert loaded.hash_models is True
    assert loaded.auto_fetch_models is False
    assert loaded.max_fetch_gb == 30


def test_config_hash_models_and_fetch_round_trip(tmp_path):
    path = tmp_path / "agent.json"
    config = AgentConfig(hash_models=False, auto_fetch_models=True, max_fetch_gb=12)
    config.save(str(path))

    loaded = AgentConfig.load(str(path))
    assert loaded.hash_models is False
    assert loaded.auto_fetch_models is True
    assert loaded.max_fetch_gb == 12


def test_config_save_is_not_group_or_world_readable(tmp_path):
    path = tmp_path / "nested" / "agent.json"
    config = AgentConfig(
        platforms=[
            PlatformEntry(
                platform_url="http://p",
                platform_pubkey="aa",
                worker_id="w1",
                certificate="cc",
                signing_key_hex="11" * 32,
            )
        ]
    )
    config.save(str(path))

    assert json.loads(path.read_text(encoding="utf-8"))["platforms"][0]["worker_id"] == "w1"

    mode = stat.S_IMODE(os.stat(path).st_mode)
    if os.name == "posix":
        assert mode == 0o600
    else:
        # chmod on Windows only toggles the read-only bit; the write must
        # still succeed and leave the owner able to read it.
        assert mode & stat.S_IRUSR
