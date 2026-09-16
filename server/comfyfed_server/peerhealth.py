"""平台端的種子可連性驗證（Phase 3.4 §4.2，cloud parity:
`cloud/src/core/peerhealth.ts`）。

Phase 3.1 的平台完全不驗 `peer_url`：worker 自己說什麼就是什麼，配到一個
連不到的種子只會讓拉方多等一次 connect timeout 再落回官方載點。這個模組
補上兩件事，而且刻意只有這兩件：

1. **靜態拒絕**：`peer_url` 的主機是 loopback／link-local／私有網段（含
   CGNAT 100.64/10）時直接標 `peer_reachable = 0`，**不發任何請求** ——
   這同時關掉舊文件記載的「申報內網位址誘導平台或其他 agent 對該位址發
   請求」的轉發面。
2. **主動探針**：對 `<peer_url>/peer/health` 發一個 3 秒的 GET，只認 204。
   那條路由不需要憑證、不回任何識別資訊（見 agent 的 peerserve.HEALTH_PATH）。

失敗（timeout、連線拒絕、非 204）一律是「不可連」，不是錯誤：不拋例外、
不影響 hello 主流程（spec §8）。

模組介面（兩棧同名同義，TS 版是 camelCase）：

- `PRIVATE_NETWORKS`：靜態拒絕的網段清單。
- `is_private_peer_url(url)` / `isPrivatePeerUrl`
- `health_url(peer_url)` / `healthUrl`：探針真正打的位址。
- `refresh(worker_id, peer_url, *, notify=None, notify_on_change_only=False)`
- `needs_recheck(checked_at, now)` / `needsRecheck`：心跳重測的判斷。
- `TIMEOUT_SECONDS`（TS: `TIMEOUT_MS`）、`RECHECK_SECONDS`（TS: `RECHECK_MS`）、
  `HEALTH_PATH`。
- `_probe(url)`：唯一真的發請求的地方（測試 monkeypatch 這個）。
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
from datetime import datetime, timezone
from typing import Awaitable, Callable, Optional
from urllib.parse import urlsplit

import httpx

from . import db

logger = logging.getLogger(__name__)

# Global Constraints：可連性檢查 3 秒；心跳時超過 10 分鐘就重測。
TIMEOUT_SECONDS = 3.0
RECHECK_SECONDS = 600
# 必須與 agent 的 `peerserve.HEALTH_PATH` 逐字相同。
HEALTH_PATH = "/peer/health"

# spec §4.2 的清單，逐字：10/8、172.16/12、192.168/16、169.254/16、
# fc00::/7、::1；loopback 127/8 與 IPv6 link-local fe80::/10 一併（同樣不是
# 公網位址）。100.64/10 是 CGNAT（裁示補上）：電信商級 NAT 後面的位址，
# 對外一樣不可能連得到，而且與 agent 端 natmap 的私有判定逐條對齊。
PRIVATE_NETWORKS = tuple(
    ipaddress.ip_network(cidr)
    for cidr in (
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "169.254.0.0/16",
        "127.0.0.0/8",
        "100.64.0.0/10",
        "fc00::/7",
        "::1/128",
        "fe80::/10",
    )
)


def is_private_peer_url(url: str) -> bool:
    """`url` 的主機是私有／loopback／link-local 位址。主機名（不是 IP）回
    False —— 我們不在這裡做 DNS 解析（那會變成另一個可被誘導的請求面），
    主機名交給真正的探針去試。"""
    host = urlsplit(url).hostname
    if not host:
        return True  # 解不出主機的 URL 本來就不可能連得到
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return any(address in network for network in PRIVATE_NETWORKS)


def health_url(peer_url: str) -> str:
    """探針真正打的位址：`peer_url` 去掉結尾斜線再接 `HEALTH_PATH`。也是推給
    agent 的 `peer_status.checked_url`。"""
    return peer_url.rstrip("/") + HEALTH_PATH


def _probe(url: str) -> bool:
    """BLOCKING：對 `url` 發一個 GET，只有 204 算通過。呼叫端一律以
    `asyncio.to_thread` 執行（Global Constraints）。測試 monkeypatch 這個
    函式來模擬 204／timeout。"""
    try:
        with httpx.Client(timeout=TIMEOUT_SECONDS, follow_redirects=False) as client:
            return client.get(url).status_code == 204
    except Exception:
        return False


def _utcnow() -> datetime:
    """Naive UTC，與 `agentws._utcnow` 同一個慣例（整個 schema 存的都是
    naive UTC，`dispatch.requeue_stale` 直接拿來比大小）。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _record(worker_id: str, reachable: Optional[bool]) -> Optional[int]:
    """把結論寫進 `workers`，回傳**寫入前**庫裡存的 `peer_reachable`（給
    「只有結論變了才推」的比較用；worker 不存在時一樣回 None）。"""
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        if worker is None:
            return None
        previous = worker.peer_reachable
        worker.peer_reachable = None if reachable is None else int(reachable)
        worker.peer_checked_at = None if reachable is None else _utcnow()
        session.commit()
        return previous


async def refresh(
    worker_id: str,
    peer_url: Optional[str],
    *,
    notify: Optional[Callable[[str, bool, str], Awaitable[None]]] = None,
    notify_on_change_only: bool = False,
) -> Optional[bool]:
    """驗一台 worker 的 `peer_url` 並落庫。回 True/False/None（沒有
    `peer_url` ⇒ 清成未檢查）。

    `notify` 有給的話就推一次 `peer_status`（spec §4.3）。什麼時候推，由
    `notify_on_change_only` 決定（裁示）：

    - hello 觸發的檢查（預設 False）：**每次**檢查完成都推一次，agent 剛
      連上就一定會拿到一則結論。
    - 心跳觸發的重測（True）：只有結論相對於庫裡存的 `peer_reachable` 真的
      變了才推，免得每 10 分鐘對每台 worker 灌一則沒有新資訊的訊息。

    任何例外都吞掉並記 log —— 這是背景工作，絕不影響 hello／heartbeat
    主流程（spec §8）。
    """
    try:
        if not peer_url:
            _record(worker_id, None)
            return None

        checked_url = health_url(peer_url)
        if is_private_peer_url(peer_url):
            logger.info(
                "peerhealth: worker %s advertises a private peer_url (%s); marking unreachable "
                "without probing",
                worker_id,
                peer_url,
            )
            reachable = False
        else:
            reachable = await asyncio.to_thread(_probe, checked_url)

        previous = _record(worker_id, reachable)
        if notify is not None and not (
            notify_on_change_only and previous is not None and bool(previous) is reachable
        ):
            await notify(worker_id, reachable, checked_url)
        return reachable
    except Exception:
        logger.exception("peerhealth: reachability check for worker %s failed", worker_id)
        return None


def needs_recheck(checked_at: Optional[datetime], now: datetime) -> bool:
    """心跳時是否該重測（`peer_checked_at` 超過 10 分鐘，或從沒測過）。
    庫裡存的是 naive UTC，所以 naive 值一律當成 UTC 來比。"""
    if checked_at is None:
        return True
    if checked_at.tzinfo is None:
        checked_at = checked_at.replace(tzinfo=timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return (now - checked_at).total_seconds() >= RECHECK_SECONDS
