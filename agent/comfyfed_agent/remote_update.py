"""平台主動觸發的 agent 更新（spec §2.2「主控台按鈕：立刻更新」）。

協議：平台 → agent `{"type": "update_agent"}`；agent → 平台
`{"type": "update_ack", "status": s, "detail": d}`，
`s ∈ {updating, deferred, up_to_date, declined, failed}`。

判定順序（`RemoteUpdater.handle_update_agent`）：

- `update.check` 說沒新版 → `up_to_date`。
- `auto_update` 為 false → `declined`：機器擁有者的設定勝過遠端管理員，平台在
  別人的機器上不是 root。
- 正在跑工作 → `deferred`：記下 decision，該工作結束（成功、失敗或取消都走
  `AgentLoop._on_job_task_done`）後由 `apply_pending_if_idle` 套用；之後不再補
  第二個 ack，只寫 log。
- 閒置 → 立刻 `apply_update(restart=noop)`；成功回 `updating` 並請 AgentLoop
  以 `RESTART_EXIT_CODE` 結束（交給 launchd／systemd／launcher.ps1 重拉），
  失敗回 `failed`，繼續用舊版。

`update.check` 與 `apply_update` 都是阻塞的 httpx／pip 呼叫，一律丟到
`asyncio.to_thread`；也正因為在執行緒裡 `SystemExit` 只會殺掉執行緒，重啟不
在這裡做，而是透過 `request_restart` 回呼交給事件圈上的 AgentLoop。
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Callable, Optional, Protocol

import httpx

from . import update
from .config import AgentConfig, PlatformEntry

logger = logging.getLogger(__name__)

STATUS_UPDATING = "updating"
STATUS_DEFERRED = "deferred"
STATUS_UP_TO_DATE = "up_to_date"
STATUS_DECLINED = "declined"
STATUS_FAILED = "failed"
ACK_STATUSES = frozenset(
    {STATUS_UPDATING, STATUS_DEFERRED, STATUS_UP_TO_DATE, STATUS_DECLINED, STATUS_FAILED}
)


class AckConnection(Protocol):
    """The slice of `runner.PlatformConnection` this module touches."""

    entry: PlatformEntry

    async def send_update_ack(self, status: str, detail: str) -> None: ...


@dataclass(frozen=True)
class PendingUpdate:
    """A decision parked until the running job finishes (`deferred`)."""

    conn: AckConnection
    decision: update.UpdateDecision


def _noop_restart() -> None:
    """`apply_update`'s default restart raises SystemExit -- fatal only to the
    worker thread it runs on. The event loop restarts via `AgentLoop.exit_code`."""


def check_in_thread(entry: PlatformEntry, current: str) -> update.UpdateDecision:
    """Blocking version check; meant for `asyncio.to_thread`."""
    with httpx.Client() as client:
        return update.check(entry, current, client)


def apply_in_thread(entry: PlatformEntry, decision: update.UpdateDecision) -> bool:
    """Blocking download + verify + pip install; meant for `asyncio.to_thread`."""
    with httpx.Client() as client:
        return update.apply_update(entry, decision, client, restart=_noop_restart)


class RemoteUpdater:
    """State machine behind `update_agent`, owned by one `AgentLoop`.

    `running_job_id` answers "is this process busy right now" (the loop's
    own `handle.running` verdict, never a per-connection state);
    `request_restart` is invoked on the event loop after a successful apply.
    """

    def __init__(
        self,
        config: AgentConfig,
        current_version: str,
        running_job_id: Callable[[], Optional[str]],
        request_restart: Callable[[], None],
    ) -> None:
        self._config = config
        self._current_version = current_version
        self._running_job_id = running_job_id
        self._request_restart = request_restart
        self.pending: Optional[PendingUpdate] = None

    async def handle_update_agent(self, conn: AckConnection) -> None:
        """Decide (and, when idle, apply), then send exactly one ack."""
        status, detail = await self._decide(conn)
        logger.info(
            "遠端更新請求 / remote update request from %s: %s (%s)",
            conn.entry.platform_url, status, detail,
        )
        try:
            await conn.send_update_ack(status, detail)
        except Exception:
            logger.exception(
                "runner: could not send update_ack %r to %s", status, conn.entry.platform_url
            )

    async def _decide(self, conn: AckConnection) -> tuple[str, str]:
        try:
            decision = await asyncio.to_thread(check_in_thread, conn.entry, self._current_version)
        except Exception as exc:
            logger.exception("runner: remote update check against %s raised", conn.entry.platform_url)
            return STATUS_FAILED, f"version check raised: {exc}"

        if decision.action != "update":
            return STATUS_UP_TO_DATE, f"running {self._current_version}, platform latest {decision.latest}"
        if not self._config.auto_update:
            return STATUS_DECLINED, "auto_update is off in this machine's agent.json"

        job_id = self._running_job_id()
        if job_id is not None:
            self.pending = PendingUpdate(conn=conn, decision=decision)
            return STATUS_DEFERRED, f"job {job_id} is running; will update to {decision.latest} after it finishes"

        applied = await self._apply(conn.entry, decision)
        if applied:
            return STATUS_UPDATING, f"{self._current_version} -> {decision.latest}; restarting"
        return STATUS_FAILED, f"download or signature verification failed; still on {self._current_version}"

    async def apply_pending_if_idle(self) -> None:
        """Called whenever a job task ends; applies the parked decision once
        no job is running. Logs the outcome -- no second ack is sent."""
        pending = self.pending
        if pending is None or self._running_job_id() is not None:
            return
        self.pending = None
        applied = await self._apply(pending.conn.entry, pending.decision)
        if applied:
            logger.info(
                "延後的更新已套用 / deferred update to %s applied; restarting", pending.decision.latest
            )
        else:
            logger.warning(
                "延後的更新失敗，繼續用舊版 / deferred update to %s failed; staying on %s",
                pending.decision.latest, self._current_version,
            )

    async def _apply(self, entry: PlatformEntry, decision: update.UpdateDecision) -> bool:
        try:
            applied = await asyncio.to_thread(apply_in_thread, entry, decision)
        except Exception:
            logger.exception("runner: apply_update for %s raised", decision.latest)
            return False
        if applied:
            self._request_restart()
        return applied
