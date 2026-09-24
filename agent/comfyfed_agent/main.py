"""comfyfed-agent CLI: register with a platform, then run the job loop."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import socket
import sys

import httpx

from datetime import datetime, timezone

from . import __version__, control, detect, identity, natmap, peerserve, update
from .config import AgentConfig
from .runner import AgentLoop, AllRegistrationsRejected, PlatformConnection, _is_auth_rejected

DEFAULT_CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".comfyfed", "agent.json")

# How stale the agent's published state may be before `status` calls the
# agent "not running". The control loop refreshes agent_state.json every 5s
# (runner._CONTROL_TICK_SECONDS), so four ticks' worth of slack means one
# missed or slow tick never reads as a dead service, while a genuinely dead
# agent is reported as such within ~20s instead of two minutes.
_STATE_STALE_SECONDS = 20.0


def _cmd_register(args: argparse.Namespace) -> None:
    # utf-8-sig: tolerate a UTF-8 BOM -- Windows tooling (PS 5.1 Set-Content
    # -Encoding UTF8, Notepad) loves to prepend one, and json.load rejects
    # it under strict utf-8 (live-caught during a real one-line install).
    with open(args.bundle, "r", encoding="utf-8-sig") as f:
        bundle = json.load(f)

    name = args.name or socket.gethostname()

    with httpx.Client() as client:
        entry = identity.register(bundle, name, args.config, client)

    print(f"Registered worker '{name}' ({entry.worker_id}) with platform {entry.platform_url}")
    print(f"Config saved to {args.config}")

    # Auto-detect the local ComfyUI so a fresh install needs no hand-edited
    # agent.json (user directive, 2026-09-14): port via /system_stats
    # fingerprint, models/output/input dirs via /internal/folder_paths.
    cfg = AgentConfig.load(args.config)
    with httpx.Client() as client:
        notes = detect.apply_detection(cfg, client, AgentConfig.comfy_url)
    if notes:
        cfg.save(args.config)
        for note in notes:
            print(f"  {note}")
    with httpx.Client() as client:
        comfy_ok = detect.probe_comfy(cfg.comfy_url, client)
    if not comfy_ok:
        print(
            "找不到本機 ComfyUI（請確認它正在執行，或在 agent.json 填 comfy_url）。/ "
            "No local ComfyUI found -- make sure it is running, or set comfy_url in agent.json."
        )


def _cmd_run(args: argparse.Namespace) -> None:
    cfg = AgentConfig.load(args.config)
    if not cfg.platforms:
        # Reachable two ways now: a never-registered machine, and one whose
        # only registration was 4401-dead and got pruned to agent.dead.json
        # on the previous run (see runner.AgentLoop._prune_dead_registration).
        # Re-running the installer is the path that covers BOTH, so name it.
        print(
            f"{args.config} 中沒有任何已註冊的平台。請重新執行安裝指令，"
            f"或執行 'comfyfed-agent register <bundle.json>'。 / "
            f"No platforms registered in {args.config}. "
            f"Re-run the installer, or run 'comfyfed-agent register <bundle.json>' first."
        )
        return

    # Auto-detect / re-detect the local ComfyUI before starting: fills any
    # still-missing dirs and recovers a moved port (only when comfy_url is
    # the untouched default) -- see detect.apply_detection's contract.
    with httpx.Client() as client:
        notes = detect.apply_detection(cfg, client, AgentConfig.comfy_url)
        if notes:
            cfg.save(args.config)
            for note in notes:
                print(f"  {note}")
        if not detect.probe_comfy(cfg.comfy_url, client):
            print(
                f"連不上 ComfyUI（{cfg.comfy_url}）——請確認它正在執行，或在 {args.config} 修改 comfy_url。/ "
                f"Cannot reach ComfyUI at {cfg.comfy_url} -- make sure it is running, or fix comfy_url in {args.config}."
            )

    # One agent install may be pinned to multiple platforms; checking the
    # first is enough since any pinned platform can vouch for whether this
    # agent build is still supported.
    with httpx.Client() as client:
        decision = update.check(cfg.platforms[0], __version__, client)

        if decision.action == "blocked":
            print(
                f"This agent version ({__version__}) is no longer supported by "
                f"{cfg.platforms[0].platform_url} (minimum: {decision.min_supported}). "
                "請更新 comfyfed-agent 後再啟動 / Please update comfyfed-agent before starting."
            )
            sys.exit(3)

        if decision.action == "update":
            if cfg.auto_update:
                print(f"Updating comfyfed-agent {__version__} -> {decision.latest}...")
                if not update.apply_update(cfg.platforms[0], decision, client):
                    print("Update failed verification; continuing with the current version.")
            else:
                print(f"新版本可用 / A new version is available: {decision.latest} (auto_update is off).")

    print(f"Starting agent loop for {len(cfg.platforms)} platform(s)...")
    agent_loop = AgentLoop(cfg, args.config)
    try:
        asyncio.run(agent_loop.run())
    except AllRegistrationsRejected:
        # Every configured registration was 4401-rejected and none ever
        # connected -- a dead install (workers deleted, or credentials
        # invalid). Say so loudly and exit non-zero so a foreground run and
        # the log both make the problem obvious, rather than looking alive.
        print(
            "所有已註冊的平台都拒絕了本 agent（worker 可能已被移除或憑證失效），"
            "沒有任何一個連線成功。請重新執行安裝指令以重新註冊。/ "
            "Every registered platform rejected this agent (workers removed or "
            "credentials invalid); none connected. Re-run the installer to re-register.",
            file=sys.stderr,
        )
        sys.exit(4)
    except RuntimeError as exc:
        # `_graceful_shutdown_and_stop` calls `loop.stop()` from a task once
        # a console signal (Ctrl-C / CTRL_BREAK) has been handled and the job
        # wound down cleanly -- but `asyncio.run`'s own `run_until_complete`
        # was still waiting on the `run()` coroutine (parked in `gather`),
        # not on that task, so it raises this exact RuntimeError rather than
        # returning normally. That is expected and not an error: swallow it
        # and exit 0. Any OTHER RuntimeError (no signal ever seen) is a real
        # bug and must keep propagating.
        if agent_loop.shutdown_in_progress and "Event loop stopped before Future completed" in str(exc):
            _exit_after_loop(agent_loop)
            sys.exit(0)
        raise
    # `run()` returned on its own (no signal): still honour a restart request.
    _exit_after_loop(agent_loop)


def _exit_after_loop(agent_loop: AgentLoop) -> None:
    """A platform-initiated update (spec §2.2) cannot `sys.exit` from the
    worker thread it installs on; it records `AgentLoop.exit_code`
    (`update.RESTART_EXIT_CODE`) instead and we exit with it here, once the
    event loop is gone. None means an ordinary exit and changes nothing."""
    if agent_loop.exit_code is not None:
        sys.exit(agent_loop.exit_code)


# Per-entry timeout for `check-registration`'s live WS probe. Short on
# purpose: the installer runs this synchronously before deciding whether to
# re-register, so it must answer fast and never hang on an unreachable host.
_CHECK_REGISTRATION_TIMEOUT_SECONDS = 5.0


async def _probe_registration(entry, config: AgentConfig, timeout: float) -> str:
    """Attempt a real WS connect + handshake for one pinned platform entry,
    reusing `PlatformConnection` so this exercises the exact auth path the
    running agent does. Returns one of:

    - `"ok"`     -- connected and completed the handshake (registration live).
    - `"rejected"` -- the platform closed with 4401 (unknown/deleted worker or
      a bad signature): a DEFINITIVE dead registration. A newer platform
      answers a handshake timeout with 4408 and an admin-disabled worker with
      4403, so neither lands here -- both fall into `"unknown"`, i.e. the
      installer never re-registers over a transient or reversible condition.
    - `"unknown"` -- anything else (network error, timeout, unexpected reply):
      cannot tell, so the installer must NOT re-register on this alone.

    One probe, one verdict: unlike the long-running agent (which requires two
    consecutive 4401s before pruning), this is an explicit operator/installer
    check whose only action is to re-register, so a single definitive 4401 is
    enough here.
    """
    conn = PlatformConnection(entry, config)
    try:
        await asyncio.wait_for(conn.connect(), timeout)
        await asyncio.wait_for(conn.handshake(), timeout)
        return "ok"
    except Exception as exc:
        return "rejected" if _is_auth_rejected(exc) else "unknown"
    finally:
        try:
            await conn.close()
        except Exception:
            pass


async def _check_all_registrations(cfg: AgentConfig, timeout: float) -> list[str]:
    return [await _probe_registration(entry, cfg, timeout) for entry in cfg.platforms]


_CHECK_REGISTRATION_DEAD_EXIT = 10
"""Exit code for a DEFINITIVE 4401-dead registration. Deliberately NOT 2:
argparse itself exits 2 on an unknown subcommand, so an older wheel that
predates `check-registration` (served the new installer during a rollout)
would exit 2 and be misread as 'dead' -- burning the one-time token on a
re-register of a still-live worker. 10 is a code neither argparse (2) nor an
uncaught Python error (1) ever produces, so the installer's dead-check can
never false-positive against an older binary."""


def _cmd_check_registration(args: argparse.Namespace) -> None:
    """Probe every pinned platform's live auth and exit with a code the
    installer keys off (0 live / 10 dead-4401 / 3 undetermined / 1 none)."""
    cfg = AgentConfig.load(args.config)
    if not cfg.platforms:
        print("尚未設定任何平台 / No platforms configured")
        sys.exit(1)

    results = asyncio.run(
        _check_all_registrations(cfg, _CHECK_REGISTRATION_TIMEOUT_SECONDS)
    )

    if any(r == "ok" for r in results):
        print("註冊有效：至少一個平台接受本 agent / Registration live: at least one platform accepts this agent")
        sys.exit(0)
    if any(r == "rejected" for r in results):
        print(
            "註冊已失效：平台以 4401 拒絕本 agent（worker 可能已被移除或憑證失效）/ "
            "Registration dead: platform rejected this agent with 4401 (worker removed or credentials invalid)"
        )
        sys.exit(_CHECK_REGISTRATION_DEAD_EXIT)
    print(
        "無法確認註冊狀態（連線失敗或逾時，未見 4401）/ "
        "Could not determine registration status (connection failed or timed out, no 4401)"
    )
    sys.exit(3)


def _config_dir(args: argparse.Namespace) -> str:
    """The control files live beside the config file the agent was started
    with, so `--config` is the only thing a second terminal has to match."""
    return os.path.dirname(os.path.abspath(args.config))


def _cmd_pause(args: argparse.Namespace) -> None:
    control.request_pause(_config_dir(args))
    print(
        "已暫停接收新工作（最慢一個心跳週期內生效；進行中的工作會跑完）。/ "
        "Paused: no new jobs will be accepted (takes effect within one heartbeat; "
        "the running job finishes)."
    )


def _cmd_resume(args: argparse.Namespace) -> None:
    control.clear_pause(_config_dir(args))
    print(
        "已恢復接收新工作（閒置偵測仍然有效：偵測到你在使用電腦時仍會自動暫停）。/ "
        "Resumed: new jobs will be accepted again (idle detection still applies -- "
        "the agent auto-pauses while you are using the machine, if enabled)."
    )


def _cmd_stop(args: argparse.Namespace) -> None:
    control.request_stop(_config_dir(args))
    print(
        "已要求 agent 結束：進行中的工作會被取消並清理（等同按 Ctrl-C）。"
        "想讓工作跑完再停，請先 comfyfed pause，用 comfyfed status 等到不是 busy，再 comfyfed stop。"
        "開機自啟仍在：下次登入／開機會再啟動。/ "
        "Stop requested: the running job is gracefully cancelled and cleaned up "
        "(same as Ctrl-C). To drain first, run 'comfyfed pause', wait until "
        "'comfyfed status' no longer reports busy, then 'comfyfed stop'. "
        "Autostart remains: the agent returns at next logon/boot."
    )


def _state_age_seconds(state: dict) -> float | None:
    """Seconds since the agent published `state`, or `None` if the timestamp
    is missing or unparseable (a hand-mangled file reads as stale)."""
    raw = state.get("updated_at")
    if not isinstance(raw, str):
        return None
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - parsed).total_seconds()


_AVAILABILITY_TEXT = {
    "available": "可接新工作 / available",
    "paused-manual": "手動暫停中 / paused-manual",
    "paused-active": "偵測到有人在用這台電腦 / paused-active",
}


def _availability_now(args: argparse.Namespace, config_dir: str) -> str | None:
    """`control.availability` evaluated right now, from this terminal.

    The state file only says what the agent last published (up to a tick
    old, and nothing at all while it is not running); the verdict itself is
    a pure function of the pause file plus idle detection, so `status` can
    -- and the docs promise it does -- compute it live. `None` when the
    config cannot be read, in which case the caller just omits the line.
    """
    try:
        cfg = AgentConfig.load(args.config)
    except Exception:
        return None
    return control.availability(cfg, config_dir)


# spec §3.3 的 P2P 那一行要用的可連性字樣。
_PEER_REACHABLE_TEXT = {
    True: "平台驗證通過 / verified by the platform",
    False: "不可連 / not reachable",
    None: "未檢查 / not checked yet",
}
_PEER_NAT_TEXT = {
    "natpmp": "natpmp（自動開埠 / auto port mapping）",
    "upnp": "upnp（自動開埠 / auto port mapping）",
    "manual": "手動指定 / manual",
    "lan": "僅區網 / LAN only",
    "none": "關閉 / off",
}


def _print_peer_status(state: dict | None) -> None:
    """`comfyfed status` 的 P2P 那一行（spec §3.3）。舊的 state 檔沒有
    `peer` 這個鍵，那就什麼都不印 —— 沿用原本的輸出。"""
    peer = (state or {}).get("peer")
    if not isinstance(peer, dict):
        return
    if not peer.get("enabled"):
        print("P2P 分享：關閉 / P2P sharing: off")
        return
    nat = peer.get("nat") or "lan"
    reachable = peer.get("reachable")
    reach = _PEER_REACHABLE_TEXT[reachable if isinstance(reachable, bool) else None]
    print(
        "P2P 分享：開啟（{nat}，對外 {url}，區網 {lan}，可連性：{reach}） / "
        "P2P sharing: on ({nat}, external {url}, LAN {lan}, reachability: {reach})".format(
            nat=_PEER_NAT_TEXT.get(nat, nat),
            url=peer.get("url") or "—",
            lan=peer.get("lan_url") or "—",
            reach=reach,
        )
    )


def _cmd_p2p_probe(args: argparse.Namespace) -> int:
    """`comfyfed-agent p2p-probe`（spec §11）：跑一次 §3.1 的映射流程（8 秒
    上限），成功印一行 JSON 並 exit 0，**隨即把測試映射收掉**（正式映射由
    `run` 時建立）；失敗印 `{"ok": false, "reason": ...}` 並 exit 1。

    安裝腳本就是靠這個 exit code 決定要不要在 agent.json 打開 `peer_serve`。
    """
    port = args.port
    # 探測**會刪掉**它建立的映射。如果 agent 已經在跑，`port` 上的那筆映射
    # 就是 agent 的正式映射，刪掉等於當場把做種關掉 —— 所以 agent 在跑時改
    # 用「隔壁的埠」探測（0.1.13 起；0.1.12 是直接拒絕，結果升級安裝永遠
    # 探不到路由器，因為安裝腳本升級時 agent 都在跑）。探的是路由器肯不肯
    # 開埠，用哪個埠問都一樣；映射一樣立刻收掉。回傳的 `probe_port` 讓呼叫
    # 端知道實際問的是哪個埠。
    # 「在跑」的判準與 `comfyfed status` 完全一致：state 檔存在，而且它的
    # 時間戳沒有過期（一個被 kill 掉的 agent 留下的舊檔不算）。
    agent_running = False
    state = control.read_state(_config_dir(args))
    if state is not None:
        age = _state_age_seconds(state)
        if age is not None and age <= _STATE_STALE_SECONDS:
            agent_running = True
    probe_port = port + 1 if agent_running else port
    try:
        gateway = natmap.detect_gateway()
        if gateway is None:
            print(json.dumps({"ok": False, "reason": "no_gateway"}))
            return 1
        # 把偵測到的閘道傳下去：`map_port` 沒拿到就會自己再跑一次
        # `route print`／`ip route`，白白多花一次 subprocess。
        mapping = natmap.map_port(port=probe_port, gateway=gateway)
    except Exception as exc:
        print(json.dumps({"ok": False, "reason": "error", "detail": str(exc)}))
        return 1

    if mapping is None:
        print(json.dumps({"ok": False, "reason": "no_response"}))
        return 1

    payload = {
        "ok": True,
        "method": mapping.method,
        "probe_port": probe_port,
        "agent_running": agent_running,
        "external_ip": mapping.external_ip,
        "external_port": mapping.external_port,
        "lan_ip": peerserve._detect_local_ip(),
    }
    print(json.dumps(payload))
    # 探測不留映射：這只是「路由器肯不肯開」的一次性問答。
    natmap.unmap_port(mapping)
    return 0


def _cmd_status(args: argparse.Namespace) -> None:
    config_dir = _config_dir(args)
    paused = control.is_pause_requested(config_dir)
    state = control.read_state(config_dir)
    age = _state_age_seconds(state) if state else None

    if state is None or age is None or age > _STATE_STALE_SECONDS:
        print("agent 未在執行 / agent not running")
    else:
        reported = state.get("state") or "unknown"
        job_id = state.get("job_id")
        print(f"agent 執行中，狀態：{reported} / agent running, state: {reported}")
        if job_id:
            print(f"進行中的工作 / running job: {job_id}")
        # Only the agent knows it is parked waiting for ComfyUI; without this
        # the operator sees a bare `paused` and goes looking for a pause they
        # never set (live incident 2026-09-16).
        if state.get("reason") == "comfyui_unreachable":
            print(
                "原因：ComfyUI 尚未啟動，agent 會自動等待並在其啟動後上線。 / "
                "reason: ComfyUI is not running; the agent waits and goes "
                "online automatically once it is up."
            )

    verdict = _availability_now(args, config_dir)
    if verdict is not None:
        print(
            f"目前可用狀態：{verdict}（{_AVAILABILITY_TEXT.get(verdict, verdict)}） / "
            f"availability now: {verdict}"
        )

    if paused:
        print(
            "手動暫停中（執行 comfyfed resume 以恢復）。/ "
            "Manually paused (run 'comfyfed resume' to resume)."
        )
    else:
        print(
            "未手動暫停（閒置偵測可能仍會自動暫停）。/ "
            "Not manually paused (idle detection may still auto-pause)."
        )

    _print_peer_status(state)


def cli() -> None:
    parser = argparse.ArgumentParser(prog="comfyfed-agent", description="ComfyFed agent: run ComfyUI jobs for a platform.")
    sub = parser.add_subparsers(dest="command", required=True)

    reg = sub.add_parser("register", help="Register this agent with a platform using a registration bundle.")
    reg.add_argument("bundle", help="Path to the bundle JSON issued by the platform.")
    reg.add_argument("--name", default=None, help="Worker name (defaults to this machine's hostname).")
    reg.add_argument("--config", default=DEFAULT_CONFIG_PATH, help="Path to the agent config file.")
    reg.set_defaults(func=_cmd_register)

    runp = sub.add_parser("run", help="Connect to all registered platforms and process jobs.")
    runp.add_argument("--config", default=DEFAULT_CONFIG_PATH, help="Path to the agent config file.")
    runp.set_defaults(func=_cmd_run)

    chk = sub.add_parser(
        "check-registration",
        # Exit codes must match `_CHECK_REGISTRATION_DEAD_EXIT` (10, NOT 2 --
        # argparse itself uses 2; see that constant's docstring).
        help="檢查已註冊平台是否仍接受本 agent / Check whether the registered platform(s) still accept this agent (exit 0 live, 10 dead-4401, 3 undetermined, 1 none).",
    )
    chk.add_argument("--config", default=DEFAULT_CONFIG_PATH, help="Path to the agent config file.")
    chk.set_defaults(func=_cmd_check_registration)

    probe = sub.add_parser(
        "p2p-probe",
        help=(
            "Probe whether the router will open a port for P2P model sharing "
            "(NAT-PMP/UPnP). Run this BEFORE starting the agent: the probe "
            "releases the mapping it creates, so it refuses "
            '({"ok": false, "reason": "agent_running"}, exit 1) while a '
            "running agent is publishing its state."
        ),
    )
    probe.add_argument("--port", type=int, default=8850, help="Port to test (default 8850).")
    probe.add_argument(
        "--config",
        default=DEFAULT_CONFIG_PATH,
        help="Path to the agent config file (only read to refuse while an agent is running).",
    )
    probe.add_argument("--json", action="store_true", help="Machine-readable output (always on).")
    probe.set_defaults(func=lambda args: sys.exit(_cmd_p2p_probe(args)))

    for name, help_text, handler in (
        ("pause", "暫停接收新工作 / Stop accepting new jobs (the running job finishes).", _cmd_pause),
        ("resume", "恢復接收新工作 / Accept new jobs again.", _cmd_resume),
        ("status", "顯示 agent 狀態 / Show the agent's current state.", _cmd_status),
        ("stop", "要求 agent 結束（取消進行中的工作，等同 Ctrl-C） / Ask a running agent to shut down (the running job is cancelled, same as Ctrl-C).", _cmd_stop),
    ):
        p = sub.add_parser(name, help=help_text)
        p.add_argument("--config", default=DEFAULT_CONFIG_PATH, help="Path to the agent config file.")
        p.set_defaults(func=handler)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    cli()
