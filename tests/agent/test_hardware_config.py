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


def test_scan_models_reports_exact_size_bytes_alongside_gb(tmp_path):
    """`size_bytes` must be the EXACT `os.stat().st_size`, not derivable by
    re-multiplying the rounded `size` GB figure -- the server signs the
    fetch-manifest trust payload over this exact value (Phase 2.1 Task 2)."""
    models_dir = tmp_path / "models"
    (models_dir / "checkpoints").mkdir(parents=True)
    exact_bytes = 3 * 1024 * 1024 + 7  # deliberately not a round number of GB
    (models_dir / "checkpoints" / "sd_xl_base.safetensors").write_bytes(b"\0" * exact_bytes)

    entries = hardware.scan_models(str(models_dir))
    assert len(entries) == 1
    entry = entries[0]

    assert entry["size_bytes"] == exact_bytes
    assert isinstance(entry["size_bytes"], int)
    # The rounded GB figure alone could not reconstruct the exact value.
    assert round(entry["size"] * (1024 ** 3)) != exact_bytes


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
        digest = hashlib.sha256(b"x").hexdigest()
        return digest, [digest]

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


def test_scan_models_skips_part_files(tmp_path):
    """final-review m2: an in-progress auto-fetch download (`*.part`,
    fetcher._PART_SUFFIX) must never enter the inventory or become a hash
    candidate -- it is still being written, and reporting it would persist a
    junk model_hashes row server-side."""
    models = tmp_path / "models"
    (models / "checkpoints").mkdir(parents=True)
    (models / "checkpoints" / "real.safetensors").write_bytes(b"x" * 10)
    (models / "checkpoints" / "half.safetensors.part").write_bytes(b"y" * 10)

    entries = hardware.scan_models(str(models), hash_models=True)
    names = [e["name"] for e in entries]
    assert names == ["checkpoints/real.safetensors"]


def test_hash_file_sha256_chunk_math_smaller_than_one_chunk(tmp_path):
    """A file smaller than one CHUNK_SIZE yields exactly one chunk hash,
    equal to the whole-file hash -- Phase 3.1 addendum chunk math."""
    path = tmp_path / "small.bin"
    content = b"hello world"
    path.write_bytes(content)

    whole, chunks = hardware._hash_file_sha256(str(path))

    assert whole == hashlib.sha256(content).hexdigest()
    assert chunks == [hashlib.sha256(content).hexdigest()]


def test_hash_file_sha256_chunk_math_empty_file(tmp_path):
    """Degenerate case of "smaller than one chunk": an empty file still
    gets exactly one chunk hash, equal to the whole-file hash."""
    path = tmp_path / "empty.bin"
    path.write_bytes(b"")

    whole, chunks = hardware._hash_file_sha256(str(path))

    assert whole == hashlib.sha256(b"").hexdigest()
    assert chunks == [hashlib.sha256(b"").hexdigest()]


def test_hash_file_sha256_chunk_math_exact_multiple(tmp_path, monkeypatch):
    """A file that is an exact multiple of CHUNK_SIZE produces exactly that
    many chunk hashes -- no extra trailing empty chunk."""
    monkeypatch.setattr(hardware, "CHUNK_SIZE", 16)
    path = tmp_path / "exact.bin"
    part_a = b"A" * 16
    part_b = b"B" * 16
    path.write_bytes(part_a + part_b)

    whole, chunks = hardware._hash_file_sha256(str(path))

    assert whole == hashlib.sha256(part_a + part_b).hexdigest()
    assert chunks == [hashlib.sha256(part_a).hexdigest(), hashlib.sha256(part_b).hexdigest()]


def test_hash_file_sha256_chunk_math_remainder(tmp_path, monkeypatch):
    """A file whose length is NOT an exact multiple of CHUNK_SIZE produces a
    short final chunk hash covering just the remainder."""
    monkeypatch.setattr(hardware, "CHUNK_SIZE", 16)
    path = tmp_path / "remainder.bin"
    part_a = b"A" * 16
    tail = b"C" * 5
    path.write_bytes(part_a + tail)

    whole, chunks = hardware._hash_file_sha256(str(path))

    assert whole == hashlib.sha256(part_a + tail).hexdigest()
    assert chunks == [hashlib.sha256(part_a).hexdigest(), hashlib.sha256(tail).hexdigest()]


def test_hash_file_sha256_is_a_single_read_pass(tmp_path, monkeypatch):
    """Whole-file + chunk hashes must come from ONE pass over the file's
    bytes, not a whole-file pass followed by a separate chunking pass --
    proven here by counting `open()`/`read()` calls via an instrumented
    file object standing in for the real one."""
    monkeypatch.setattr(hardware, "CHUNK_SIZE", 4)
    path = tmp_path / "instrumented.bin"
    content = b"0123456789"  # not an exact multiple of the 4-byte chunk size
    path.write_bytes(content)

    open_calls = []
    read_calls = []
    real_open = open

    def counting_open(file, *args, **kwargs):
        opened = real_open(file, *args, **kwargs)
        if str(file) == str(path):
            open_calls.append(file)
            real_read = opened.read

            def counting_read(*a, **k):
                read_calls.append(1)
                return real_read(*a, **k)

            opened.read = counting_read
        return opened

    monkeypatch.setattr("builtins.open", counting_open)

    whole, chunks = hardware._hash_file_sha256(str(path))

    assert whole == hashlib.sha256(content).hexdigest()
    assert chunks == [
        hashlib.sha256(b"0123").hexdigest(),
        hashlib.sha256(b"4567").hexdigest(),
        hashlib.sha256(b"89").hexdigest(),
    ]
    # Exactly one open() of the target file for this whole call.
    assert len(open_calls) == 1
    # The final call to iter()'s sentinel-triggering read() returns b"" and
    # is included; what matters is that the file was never opened/read a
    # second time to derive the chunk hashes separately.
    assert len(read_calls) >= 1


def test_scan_models_reports_chunk_sha256s_alongside_sha256(tmp_path):
    """The inventory report (scan_models' return value, forwarded verbatim
    as the WS `inventory` message -- see hardware.scan_models docstring)
    must carry `chunk_sha256s` whenever it carries `sha256`."""
    models_dir = tmp_path / "models"
    models_dir.mkdir()
    (models_dir / "a.bin").write_bytes(b"hello world")
    expected_whole = hashlib.sha256(b"hello world").hexdigest()

    hardware.scan_models(str(models_dir))
    _wait_for_hash(models_dir, "a.bin")

    entries = hardware.scan_models(str(models_dir))
    entry = entries[0]
    assert entry["sha256"] == expected_whole
    assert entry["chunk_sha256s"] == [expected_whole]  # smaller than one chunk


def test_scan_models_upgrades_chunkless_sidecar_entry(tmp_path):
    """A pre-existing sidecar entry without `chunk_sha256s` (written by an
    older agent, or Task 1) counts as un-hashed and gets re-hashed on its
    normal one-per-pass turn to pick up chunk_sha256s -- the upgrade path."""
    models_dir = tmp_path / "models"
    models_dir.mkdir()
    content = b"hello world"
    (models_dir / "a.bin").write_bytes(content)
    stat_result = os.stat(models_dir / "a.bin")

    cache_path = models_dir / ".comfyfed_hashes.json"
    cache_path.write_text(
        json.dumps(
            {
                "a.bin": {
                    "size": stat_result.st_size,
                    "mtime": stat_result.st_mtime,
                    "sha256": hashlib.sha256(content).hexdigest(),
                    # no chunk_sha256s -- pre-Phase-3.1 shape
                }
            }
        ),
        encoding="utf-8",
    )

    # First pass keeps reporting the still-valid ((size, mtime) unchanged)
    # whole-file sha256 -- an upgraded worker must not go hash-dark (the P2P
    # seeder predicate needs it) -- while chunk_sha256s stays absent until
    # the background re-hash lands.
    entries = hardware.scan_models(str(models_dir))
    assert entries[0]["sha256"] == hashlib.sha256(content).hexdigest()
    assert "chunk_sha256s" not in entries[0]

    expected = hashlib.sha256(content).hexdigest()
    # Deliberately not `_wait_for_hash`: the pre-seeded cache entry already
    # has a (stale, chunkless) `sha256`, so that helper's "has a sha256"
    # check would return immediately without the background re-hash having
    # actually run. Wait for `chunk_sha256s` specifically instead.
    deadline = time.monotonic() + 5.0
    cache = {}
    while time.monotonic() < deadline:
        try:
            cache = json.loads(cache_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            cache = {}
        if cache.get("a.bin", {}).get("chunk_sha256s"):
            break
        time.sleep(0.02)
    else:
        raise AssertionError("a.bin was never upgraded with chunk_sha256s")

    assert cache["a.bin"]["sha256"] == expected
    assert cache["a.bin"]["chunk_sha256s"] == [expected]

    entries = hardware.scan_models(str(models_dir))
    assert entries[0]["sha256"] == expected
    assert entries[0]["chunk_sha256s"] == [expected]


def test_scan_models_upgrade_does_not_starve_new_files(tmp_path):
    """The upgrade path (chunkless cache entry) and a genuinely new file
    both land in the candidate pool judged by the SAME rule, so the
    smallest-first, one-per-pass schedule still applies across their union
    instead of the upgrade always winning (or always losing)."""
    models_dir = tmp_path / "models"
    models_dir.mkdir()
    old_content = b"x" * 1000  # deliberately bigger than the new file below
    (models_dir / "old.bin").write_bytes(old_content)
    old_stat = os.stat(models_dir / "old.bin")

    cache_path = models_dir / ".comfyfed_hashes.json"
    cache_path.write_text(
        json.dumps(
            {
                "old.bin": {
                    "size": old_stat.st_size,
                    "mtime": old_stat.st_mtime,
                    "sha256": hashlib.sha256(old_content).hexdigest(),
                }
            }
        ),
        encoding="utf-8",
    )

    (models_dir / "new.bin").write_bytes(b"tiny")

    # smallest-first over the union of {new.bin (new), old.bin (upgrade)}
    # picks new.bin first.
    hardware.scan_models(str(models_dir))
    new_hash = _wait_for_hash(models_dir, "new.bin")
    assert new_hash == hashlib.sha256(b"tiny").hexdigest()

    # Subsequent passes eventually pick up the upgrade candidate too.
    old_expected = hashlib.sha256(old_content).hexdigest()
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        hardware.scan_models(str(models_dir))
        cache = json.loads(cache_path.read_text(encoding="utf-8"))
        if cache.get("old.bin", {}).get("chunk_sha256s"):
            break
        time.sleep(0.05)
    else:
        raise AssertionError("old.bin was never upgraded with chunk_sha256s")
    assert cache["old.bin"]["sha256"] == old_expected
    assert cache["old.bin"]["chunk_sha256s"] == [old_expected]


def test_config_max_fetch_gb_coercion(tmp_path):
    """final-review m4: a string value coerces, garbage/non-positive falls
    back to the default instead of exploding later in fetcher's budget
    check."""
    import json as _json

    path = tmp_path / "agent.json"
    for raw, expected in [("30", 30.0), (12.5, 12.5), ("junk", 30.0), (-5, 30.0), (None, 30.0)]:
        path.write_text(_json.dumps({"max_fetch_gb": raw}), encoding="utf-8")
        assert AgentConfig.load(str(path)).max_fetch_gb == expected


def test_config_peer_serve_defaults(tmp_path):
    path = tmp_path / "agent.json"
    AgentConfig().save(str(path))

    loaded = AgentConfig.load(str(path))
    assert loaded.peer_serve is False
    assert loaded.peer_listen_port is None
    assert loaded.peer_advertise_host is None


def test_config_peer_serve_round_trip(tmp_path):
    path = tmp_path / "agent.json"
    config = AgentConfig(peer_serve=True, peer_listen_port=8850, peer_advertise_host="203.0.113.5")
    config.save(str(path))

    loaded = AgentConfig.load(str(path))
    assert loaded.peer_serve is True
    assert loaded.peer_listen_port == 8850
    assert loaded.peer_advertise_host == "203.0.113.5"


def test_config_peer_serve_coercion(tmp_path):
    """Defensive coercion, matching max_fetch_gb's posture: a hand-edited
    agent.json shouldn't be able to crash config loading, only fall back to
    the safe default."""
    import json as _json

    path = tmp_path / "agent.json"
    bool_cases = [("true", True), ("false", False), (True, True), (False, False), ("yes", True), ("no", False), ("junk", False), (None, False)]
    for raw, expected in bool_cases:
        path.write_text(_json.dumps({"peer_serve": raw}), encoding="utf-8")
        assert AgentConfig.load(str(path)).peer_serve is expected

    port_cases = [("8850", 8850), (8850, 8850), (0, None), (-1, None), ("junk", None), (None, None)]
    for raw, expected in port_cases:
        path.write_text(_json.dumps({"peer_listen_port": raw}), encoding="utf-8")
        assert AgentConfig.load(str(path)).peer_listen_port == expected

    host_cases = [("203.0.113.5", "203.0.113.5"), ("", None), (123, None), (None, None)]
    for raw, expected in host_cases:
        path.write_text(_json.dumps({"peer_advertise_host": raw}), encoding="utf-8")
        assert AgentConfig.load(str(path)).peer_advertise_host == expected


def test_config_peer_upload_limit_defaults_and_round_trip(tmp_path):
    """Tiered P2P upload cap: 20 Mbps while the user is active / manually
    paused, unlimited (0) while idle -- and both survive a save/load."""
    path = tmp_path / "agent.json"
    AgentConfig().save(str(path))

    loaded = AgentConfig.load(str(path))
    assert loaded.peer_upload_limit_mbps == 20.0
    assert loaded.peer_upload_limit_idle_mbps == 0.0

    AgentConfig(peer_upload_limit_mbps=5.5, peer_upload_limit_idle_mbps=100).save(str(path))
    loaded = AgentConfig.load(str(path))
    assert loaded.peer_upload_limit_mbps == 5.5
    assert loaded.peer_upload_limit_idle_mbps == 100.0


def test_config_peer_upload_limit_coercion(tmp_path):
    """Same defensive posture as max_fetch_gb, except `0` is MEANINGFUL here
    (= unlimited) and must survive coercion instead of falling back."""
    import json as _json

    path = tmp_path / "agent.json"
    cases = [
        ("30", 30.0),
        (12.5, 12.5),
        ("0", 0.0),
        (0, 0.0),
        ("abc", 20.0),
        (-5, 20.0),
        (float("inf"), 20.0),
        (None, 20.0),
    ]
    for raw, expected in cases:
        # json.dumps writes bare `Infinity`, which json.load accepts back --
        # exactly the "1e999 in a hand-edited file" case the coercer guards.
        path.write_text(_json.dumps({"peer_upload_limit_mbps": raw}), encoding="utf-8")
        assert AgentConfig.load(str(path)).peer_upload_limit_mbps == expected

    idle_cases = [("0", 0.0), (25, 25.0), ("abc", 0.0), (-5, 0.0), (float("inf"), 0.0)]
    for raw, expected in idle_cases:
        path.write_text(_json.dumps({"peer_upload_limit_idle_mbps": raw}), encoding="utf-8")
        assert AgentConfig.load(str(path)).peer_upload_limit_idle_mbps == expected


def test_config_load_tolerates_a_utf8_bom(tmp_path):
    """Windows tooling (PS 5.1 `Set-Content -Encoding UTF8`, Notepad) writes
    JSON with a UTF-8 BOM; strict utf-8 json.load rejects the very first
    byte (live-caught during a real one-line install). load() must accept
    both spellings identically."""
    path = tmp_path / "agent.json"
    AgentConfig(models_dir=str(tmp_path / "m")).save(str(path))
    raw = path.read_bytes()
    assert not raw.startswith(b"\xef\xbb\xbf")  # save itself stays BOM-less
    path.write_bytes(b"\xef\xbb\xbf" + raw)

    loaded = AgentConfig.load(str(path))
    assert loaded.models_dir == str(tmp_path / "m")
