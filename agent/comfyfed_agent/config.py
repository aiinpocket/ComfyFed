"""Agent-side persisted configuration: pinned platform identities + local settings."""

from __future__ import annotations

import json
import math
import os
from dataclasses import asdict, dataclass, field


def _coerce_positive_float(value, default: float) -> float:
    """`max_fetch_gb` from agent.json, defensively: a string like "30" is
    accepted, anything non-numeric or <= 0 falls back to the default instead
    of blowing up later inside fetcher's budget check as an opaque
    job_failed (final-review m4).

    Non-finite values are rejected too: `"idle_minutes": 1e999` parses as
    `inf`, which would make the machine *never* count as idle -- a worker
    permanently `paused` with no error message anywhere (final-review L5).
    """
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(result) or result <= 0:  # NaN, +/-inf or non-positive
        return default
    return result


def _coerce_bool(value, default: bool) -> bool:
    """`peer_serve` from agent.json, defensively: a real bool passes through,
    a common string spelling ("true"/"false"/"1"/"0"/"yes"/"no") is accepted
    for hand-edited configs, and anything else (missing, wrong type, unknown
    string) falls back to `default` rather than raising -- same posture as
    `_coerce_positive_float`."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in ("true", "1", "yes", "on"):
            return True
        if lowered in ("false", "0", "no", "off"):
            return False
    return default


def _coerce_optional_positive_int(value, default: int | None) -> int | None:
    """`peer_listen_port` from agent.json, defensively: a string like "8850"
    is accepted; missing/non-numeric/non-positive falls back to `default`
    (usually `None`, meaning "peer serving has no port to bind")."""
    if value is None:
        return default
    try:
        result = int(value)
    except (TypeError, ValueError):
        return default
    if result <= 0:
        return default
    return result


def _coerce_optional_str(value, default: str | None) -> str | None:
    """`peer_advertise_host` from agent.json: a non-empty string passes
    through, anything else (missing, empty, wrong type) falls back to
    `default` (`None`, meaning "auto-detect the LAN IP")."""
    if isinstance(value, str) and value:
        return value
    return default


def _coerce_str(value, default: str) -> str:
    """`peer_bind_host` from agent.json (M6 final-review fix): a non-empty
    string passes through, anything else (missing, empty, wrong type) falls
    back to `default` -- same defensive posture as the other coercers, so a
    malformed hand-edited value degrades to the safe default (still
    `"0.0.0.0"`, unchanged behavior) instead of raising or binding to
    something unintended."""
    if isinstance(value, str) and value:
        return value
    return default


def _coerce_non_negative_float(value, default: float) -> float:
    """`peer_upload_limit_mbps` / `peer_upload_limit_idle_mbps` from
    agent.json，防禦式解析：跟 `_coerce_positive_float` 同樣的姿態，唯一差別
    是 **0 是合法值**（代表「不限速」），所以只有負數、非數字、NaN/inf 才退回
    預設值。

    Same posture as `_coerce_positive_float`, except `0` is a MEANINGFUL
    value here (= unlimited), so only negative, non-numeric and non-finite
    inputs fall back to `default`.
    """
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(result) or result < 0:  # NaN, +/-inf or negative
        return default
    return result


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
    # Phase 2.1 model auto-distribution groundwork (protocol 3). `hash_models`
    # gates scan_models' lazy sha256 hashing entirely; `auto_fetch_models` is
    # only advertised in `hello` here -- the platform-driven fetch itself is
    # Tasks 2-4. `max_fetch_gb` bounds how much this worker is willing to pull
    # down automatically once that lands.
    hash_models: bool = True
    auto_fetch_models: bool = False
    max_fetch_gb: float = 30
    # Phase 3.1 P2P addendum (種子端): this worker serves model bytes to other
    # agents holding a platform-issued Grant (agent/comfyfed_agent/peerserve.py).
    # Peer serving is enabled iff BOTH `peer_serve` is true AND
    # `peer_listen_port` is set -- a bare `peer_serve: true` with no port has
    # nothing to bind and is treated as off (see peerserve.is_enabled).
    # `peer_advertise_host` overrides the auto-detected LAN IP advertised in
    # `hello.peer_url` (useful behind NAT/port-forwarding or a fixed hostname).
    peer_serve: bool = False
    peer_listen_port: int | None = None
    peer_advertise_host: str | None = None
    # M6 final-review fix: which interface(s) the peer listener binds --
    # defaults to "0.0.0.0" (unchanged behavior) but is now user-configurable
    # so a worker on a machine with a public IP can bind LAN-only (e.g.
    # "127.0.0.1" behind a reverse proxy, or a specific LAN interface IP)
    # instead of exposing the listener to the internet the moment
    # `peer_serve` is enabled.
    peer_bind_host: str = "0.0.0.0"
    # BOINC-style idle detection (2026-09-14 directive): while the human is
    # actively using this machine, the agent reports `paused` instead of
    # `idle` so the platform stops pushing NEW jobs at it. A job already
    # running is never aborted. `idle_minutes` is how long input must have
    # been quiet before the machine counts as free again. Machines where the
    # OS cannot report last-input (headless, Wayland without XWayland) are
    # treated as always idle -- see idle.seconds_since_input.
    pause_when_active: bool = True
    idle_minutes: float = 15.0
    # 分級 P2P 上傳限速（2026-09-15 directive）：做種（peerserve）跟派工不同，
    # 使用者在用電腦時仍然照常上傳——只吃 CPU 跟網路、不占 GPU——但要「有禮貌」
    # 地讓出頻寬。`peer_upload_limit_mbps` 是 availability != "available"
    # （使用者活動中或手動暫停）時套用的上限，單位 Mbps（百萬位元/秒）。
    # 預設 20 Mbps：在常見 >= 100 Mbps 的上行上仍留 >= 80% 餘裕給人用，卻還是
    # 能在大約 40 分鐘內送完一個 6.5 GB 的模型檔。
    # `peer_upload_limit_idle_mbps` 是機器閒置時的上限，`0` = 不限速（預設）。
    #
    # Tiered P2P upload cap. Seeding deliberately keeps running while the
    # human uses the machine (CPU + network only, no GPU), so it is throttled
    # instead of stopped. `peer_upload_limit_mbps` (megabits/sec) applies
    # whenever availability != "available"; 20 Mbps leaves >= 80% headroom on
    # a typical >= 100 Mbps uplink yet still moves 6.5 GB in ~40 minutes.
    # `peer_upload_limit_idle_mbps` applies while idle; `0` means UNLIMITED.
    peer_upload_limit_mbps: float = 20.0
    peer_upload_limit_idle_mbps: float = 0.0

    @classmethod
    def load(cls, path: str) -> "AgentConfig":
        """Load config from `path`. A missing file yields a default empty config."""
        if not os.path.exists(path):
            return cls()

        # utf-8-sig: tolerate a UTF-8 BOM in hand-edited configs (Windows
        # editors and PS 5.1 redirects often prepend one; strict utf-8
        # would crash json.load on the very first byte).
        with open(path, "r", encoding="utf-8-sig") as f:
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
            hash_models=data.get("hash_models", cls.hash_models),
            auto_fetch_models=data.get("auto_fetch_models", cls.auto_fetch_models),
            max_fetch_gb=_coerce_positive_float(
                data.get("max_fetch_gb"), cls.max_fetch_gb
            ),
            peer_serve=_coerce_bool(data.get("peer_serve"), cls.peer_serve),
            peer_listen_port=_coerce_optional_positive_int(
                data.get("peer_listen_port"), cls.peer_listen_port
            ),
            peer_advertise_host=_coerce_optional_str(
                data.get("peer_advertise_host"), cls.peer_advertise_host
            ),
            peer_bind_host=_coerce_str(data.get("peer_bind_host"), cls.peer_bind_host),
            pause_when_active=_coerce_bool(
                data.get("pause_when_active"), cls.pause_when_active
            ),
            idle_minutes=_coerce_positive_float(
                data.get("idle_minutes"), cls.idle_minutes
            ),
            peer_upload_limit_mbps=_coerce_non_negative_float(
                data.get("peer_upload_limit_mbps"), cls.peer_upload_limit_mbps
            ),
            peer_upload_limit_idle_mbps=_coerce_non_negative_float(
                data.get("peer_upload_limit_idle_mbps"), cls.peer_upload_limit_idle_mbps
            ),
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
            "hash_models": self.hash_models,
            "auto_fetch_models": self.auto_fetch_models,
            "max_fetch_gb": self.max_fetch_gb,
            "peer_serve": self.peer_serve,
            "peer_listen_port": self.peer_listen_port,
            "peer_advertise_host": self.peer_advertise_host,
            "peer_bind_host": self.peer_bind_host,
            "pause_when_active": self.pause_when_active,
            "idle_minutes": self.idle_minutes,
            "peer_upload_limit_mbps": self.peer_upload_limit_mbps,
            "peer_upload_limit_idle_mbps": self.peer_upload_limit_idle_mbps,
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
