"""Agent-side persisted configuration: pinned platform identities + local settings."""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field


@dataclass
class PlatformEntry:
    platform_url: str
    platform_pubkey: str
    worker_id: str
    certificate: str
    signing_key_hex: str


@dataclass
class AgentConfig:
    platforms: list[PlatformEntry] = field(default_factory=list)
    comfy_url: str = "http://127.0.0.1:8188"
    whitelist_extra: list[str] = field(default_factory=list)
    node_policy: str = "installed"
    models_dir: str | None = None
    auto_update: bool = True
    # Local ComfyUI directories, used only for post-job disk cleanup (see
    # runner.cleanup_job_files). Left unset (None) by default: cleanup then
    # skips the ComfyUI-directory step and only logs that it did so -- it
    # never guesses where ComfyUI's own input/output folders live.
    comfy_output_dir: str | None = None
    comfy_input_dir: str | None = None

    @classmethod
    def load(cls, path: str) -> "AgentConfig":
        """Load config from `path`. A missing file yields a default empty config."""
        if not os.path.exists(path):
            return cls()

        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)

        platforms = [PlatformEntry(**p) for p in data.get("platforms", [])]
        return cls(
            platforms=platforms,
            comfy_url=data.get("comfy_url", cls.comfy_url),
            whitelist_extra=list(data.get("whitelist_extra", [])),
            node_policy=data.get("node_policy", cls.node_policy),
            models_dir=data.get("models_dir"),
            auto_update=data.get("auto_update", cls.auto_update),
            comfy_output_dir=data.get("comfy_output_dir"),
            comfy_input_dir=data.get("comfy_input_dir"),
        )

    def save(self, path: str) -> None:
        """Save config to `path` as JSON, creating parent dirs and writing atomically."""
        parent = os.path.dirname(os.path.abspath(path))
        if parent:
            os.makedirs(parent, exist_ok=True)

        data = {
            "platforms": [asdict(p) for p in self.platforms],
            "comfy_url": self.comfy_url,
            "whitelist_extra": list(self.whitelist_extra),
            "node_policy": self.node_policy,
            "models_dir": self.models_dir,
            "auto_update": self.auto_update,
            "comfy_output_dir": self.comfy_output_dir,
            "comfy_input_dir": self.comfy_input_dir,
        }

        tmp_path = f"{path}.tmp-{os.getpid()}"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp_path, path)

        # This file holds every platform's Ed25519 signing key in the clear,
        # so it must not be world- or group-readable. Best-effort: chmod is a
        # no-op for permissions on Windows and can fail on exotic filesystems,
        # and neither case is worth failing a config write over.
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass
