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
        }

        tmp_path = f"{path}.tmp-{os.getpid()}"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp_path, path)
