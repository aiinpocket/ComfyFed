"""Agent-side model inventory units and config-file hardening."""

import json
import os
import stat

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
