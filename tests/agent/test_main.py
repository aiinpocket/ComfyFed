"""`comfyfed-agent run` CLI entry: the RuntimeError `_graceful_shutdown_and_stop`'s
`loop.stop()` provokes out of `asyncio.run` must be swallowed for a clean,
signal-initiated shutdown -- and nothing else."""

import argparse
import sys

import pytest

from comfyfed_agent import main as main_module
from comfyfed_agent.config import AgentConfig, PlatformEntry
from comfyfed_agent.runner import AgentLoop, AllRegistrationsRejected
from comfyfed_agent import update


def _args(config_path: str) -> argparse.Namespace:
    return argparse.Namespace(config=config_path)


def _entry() -> PlatformEntry:
    return PlatformEntry(
        platform_url="http://platform.example",
        platform_pubkey="pp",
        worker_id="worker-a",
        certificate="cert",
        signing_key_hex="11" * 32,
    )


@pytest.fixture(autouse=True)
def _no_update_check(monkeypatch):
    monkeypatch.setattr(
        update, "check", lambda *a, **k: update.UpdateDecision(action="ok", latest="0.0.0", min_supported="0.0.0")
    )
    monkeypatch.setattr(AgentConfig, "load", lambda path: AgentConfig(platforms=[_entry()]))


def test_run_exits_cleanly_when_shutdown_already_in_progress(monkeypatch, tmp_path):
    """The exact case the live driver hit: a signal was handled, `shutdown()`
    finished, `loop.stop()` ran -- and `asyncio.run` surfaces that as a
    RuntimeError instead of `run()` returning normally. That must become a
    quiet `sys.exit(0)`, not a traceback."""

    async def _raise_after_shutdown(self):
        self._shutdown_in_progress = True
        raise RuntimeError("Event loop stopped before Future completed.")

    monkeypatch.setattr(AgentLoop, "run", _raise_after_shutdown)

    with pytest.raises(SystemExit) as exc_info:
        main_module._cmd_run(_args(str(tmp_path / "agent.json")))

    assert exc_info.value.code == 0


def test_run_reraises_the_same_runtimeerror_without_a_signal(monkeypatch, tmp_path):
    """The same message, but no signal was ever handled: this is a genuine
    bug (or some other asyncio failure), not a clean shutdown, and must not
    be swallowed."""

    async def _raise_without_shutdown(self):
        raise RuntimeError("Event loop stopped before Future completed.")

    monkeypatch.setattr(AgentLoop, "run", _raise_without_shutdown)

    with pytest.raises(RuntimeError, match="Event loop stopped before Future completed"):
        main_module._cmd_run(_args(str(tmp_path / "agent.json")))


def test_run_reraises_unrelated_runtimeerror_even_during_shutdown(monkeypatch, tmp_path):
    """Only the specific `loop.stop()` message is treated as a clean
    shutdown; any other RuntimeError -- even with the flag set -- is a real
    failure and must keep propagating."""

    async def _raise_other(self):
        self._shutdown_in_progress = True
        raise RuntimeError("something else entirely broke")

    monkeypatch.setattr(AgentLoop, "run", _raise_other)

    with pytest.raises(RuntimeError, match="something else entirely broke"):
        main_module._cmd_run(_args(str(tmp_path / "agent.json")))


def test_run_exits_4_with_a_bilingual_message_when_all_registrations_rejected(
    monkeypatch, tmp_path, capsys
):
    """Every configured registration was 4401-rejected and none connected:
    `run()` raises `AllRegistrationsRejected`, which `_cmd_run` turns into a
    loud bilingual message on stderr and a non-zero exit (4)."""

    async def _all_rejected(self):
        raise AllRegistrationsRejected("all dead")

    monkeypatch.setattr(AgentLoop, "run", _all_rejected)

    with pytest.raises(SystemExit) as exc_info:
        main_module._cmd_run(_args(str(tmp_path / "agent.json")))

    assert exc_info.value.code == 4
    err = capsys.readouterr().err
    assert "所有已註冊的平台都拒絕了本 agent" in err
    assert "Re-run the installer to re-register" in err


# --- Phase 3.4 Task 3: `status` 的 P2P 那一行與 `p2p-probe` 子命令 ---------

import json  # noqa: E402

from comfyfed_agent import control, main, natmap  # noqa: E402


def _state(tmp_path, peer):
    control.write_state(str(tmp_path), "idle", None, peer=peer)


def _probe_args(port: int = 8850) -> argparse.Namespace:
    return argparse.Namespace(port=port, json=True)


def test_status_prints_the_p2p_line_when_sharing_is_on(tmp_path, capsys):
    _state(
        tmp_path,
        {
            "enabled": True,
            "nat": "natpmp",
            "url": "http://203.0.113.7:8850",
            "lan_url": "http://192.168.1.5:8850",
            "reachable": True,
        },
    )
    main._print_peer_status(control.read_state(str(tmp_path)))
    out = capsys.readouterr().out
    assert "natpmp" in out
    assert "http://203.0.113.7:8850" in out
    assert "http://192.168.1.5:8850" in out
    assert "平台驗證通過" in out


def test_status_prints_p2p_off(tmp_path, capsys):
    _state(tmp_path, {"enabled": False, "nat": "none", "url": None, "lan_url": None, "reachable": None})
    main._print_peer_status(control.read_state(str(tmp_path)))
    assert "關閉" in capsys.readouterr().out


def test_status_without_a_peer_block_prints_nothing(capsys):
    main._print_peer_status({"state": "idle"})
    assert capsys.readouterr().out == ""


def test_p2p_probe_prints_json_and_exits_zero(monkeypatch, capsys):
    mapping = natmap.Mapping(
        method="upnp",
        external_ip="203.0.113.7",
        external_port=8850,
        internal_port=8850,
        lifetime=3600,
        gateway="192.168.1.1",
        control_url="http://192.168.1.1:5000/ctl/IPConn",
        service_type="urn:schemas-upnp-org:service:WANIPConnection:1",
    )
    released = []
    seen = []
    monkeypatch.setattr(natmap, "detect_gateway", lambda: "192.168.1.1")
    monkeypatch.setattr(natmap, "map_port", lambda **kwargs: seen.append(kwargs) or mapping)
    monkeypatch.setattr(natmap, "unmap_port", lambda m: released.append(m))
    monkeypatch.setattr(main.peerserve, "_detect_local_ip", lambda: "192.168.1.5")

    rc = main._cmd_p2p_probe(_probe_args(port=8850))

    assert rc == 0
    payload = json.loads(capsys.readouterr().out.strip())
    assert payload == {
        "ok": True,
        "method": "upnp",
        "external_ip": "203.0.113.7",
        "external_port": 8850,
        "lan_ip": "192.168.1.5",
    }
    # 探測不留映射 —— 正式映射由 `run` 時建立。
    assert released == [mapping]
    # 閘道只偵測一次，結果直接傳給 map_port（`route print` 不跑第二遍）。
    assert seen == [{"port": 8850, "gateway": "192.168.1.1"}]


def test_p2p_probe_reports_no_gateway(monkeypatch, capsys):
    monkeypatch.setattr(natmap, "detect_gateway", lambda: None)
    rc = main._cmd_p2p_probe(_probe_args())
    assert rc == 1
    assert json.loads(capsys.readouterr().out.strip()) == {"ok": False, "reason": "no_gateway"}


def test_p2p_probe_reports_no_response(monkeypatch, capsys):
    monkeypatch.setattr(natmap, "detect_gateway", lambda: "192.168.1.1")
    monkeypatch.setattr(natmap, "map_port", lambda **kwargs: None)
    rc = main._cmd_p2p_probe(_probe_args())
    assert rc == 1
    assert json.loads(capsys.readouterr().out.strip()) == {"ok": False, "reason": "no_response"}


def test_p2p_probe_reports_error_on_an_exception(monkeypatch, capsys):
    monkeypatch.setattr(natmap, "detect_gateway", lambda: "192.168.1.1")

    def boom(**kwargs):
        raise RuntimeError("socket exploded")

    monkeypatch.setattr(natmap, "map_port", boom)
    rc = main._cmd_p2p_probe(_probe_args())
    assert rc == 1
    payload = json.loads(capsys.readouterr().out.strip())
    assert payload["ok"] is False
    assert payload["reason"] == "error"


def test_p2p_probe_is_registered_as_a_subcommand(monkeypatch):
    """安裝腳本靠 `comfyfed-agent p2p-probe` 的 exit code 決定要不要打開
    `peer_serve`，所以這個子命令必須真的掛在 CLI 上。"""
    monkeypatch.setattr(sys, "argv", ["comfyfed-agent", "p2p-probe", "--port", "9999", "--json"])
    monkeypatch.setattr(natmap, "detect_gateway", lambda: None)
    with pytest.raises(SystemExit) as exc:
        main.cli()
    assert exc.value.code == 1
