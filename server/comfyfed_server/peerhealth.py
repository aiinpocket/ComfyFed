"""平台端的種子可連性驗證（Phase 3.4 §4.2，cloud parity:
`cloud/src/core/peerhealth.ts`）。

Phase 3.1 的平台完全不驗 `peer_url`：worker 自己說什麼就是什麼，配到一個
連不到的種子只會讓拉方多等一次 connect timeout 再落回官方載點。這個模組
補上三件事，而且刻意只有這三件：

1. **靜態拒絕**：`peer_url` 的主機是 loopback／link-local／私有網段（含
   CGNAT 100.64/10）時直接標 `peer_reachable = 0`，**不發任何請求** ——
   這同時關掉舊文件記載的「申報內網位址誘導平台或其他 agent 對該位址發
   請求」的轉發面。判定前先把主機正規化：`2130706433`／`0177.0.0.1`／
   `127.1` 這類非四段十進位的 IPv4 寫法（`socket.inet_aton` 認得，作業
   系統的連線函式也認得）與 IPv4-mapped IPv6（`::ffff:10.0.0.1`）都會被
   還原成正規位址再比對，否則它們會從字面比對的縫隙溜過去。
2. **只驗 IP 字面值**（fix round 1 裁示）：主機不是 IP 字面值（是個 DNS
   名稱）時**完全不探**，`peer_reachable` 留在 NULL、只記 debug —— 一個
   名稱今天解到哪、明天解到哪都不是我們能保證的，驗過也不代表什麼。
3. **主動探針**：對 `<peer_url>/peer/health` 發一個 3 秒的 GET，只認 204，
   而且**不讀 body**（`client.stream`，拿到 status 就關）。那條路由不需要
   憑證、不回任何識別資訊（見 agent 的 peerserve.HEALTH_PATH）。

失敗（timeout、連線拒絕、非 204）一律是「不可連」，不是錯誤：不拋例外、
不影響 hello 主流程（spec §8）。

模組介面（兩棧同名同義，TS 版是 camelCase）：

- `PRIVATE_NETWORKS`：靜態拒絕的網段清單。
- `is_private_peer_url(url)` / `isPrivatePeerUrl`
- `is_ip_literal_peer_url(url)` / `isIpLiteralPeerUrl`：主機是不是 IP 字面值。
- `peer_host_address(url)` / `peerHostAddress`：正規化後的位址（或 None）。
- `health_url(peer_url)` / `healthUrl`：探針真正打的位址。
- `refresh(worker_id, peer_url, *, notify=None, notify_on_change_only=False)`
- `needs_recheck(checked_at, now)` / `needsRecheck`：心跳重測的判斷。
- `TIMEOUT_SECONDS`（TS: `TIMEOUT_MS`）、`MAX_PROBE_SECONDS`、
  `RECHECK_SECONDS`（TS: `RECHECK_MS`）、`HEALTH_PATH`。
- `_probe(url)`：唯一真的發請求的地方（測試 monkeypatch 這個）。
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import socket
import time
from datetime import datetime, timezone
from typing import Awaitable, Callable, Optional, Union
from urllib.parse import urlsplit

import httpx

from . import db

logger = logging.getLogger(__name__)

# Global Constraints：可連性檢查 3 秒；心跳時超過 10 分鐘就重測。
TIMEOUT_SECONDS = 3.0
# 探針佔住執行緒的牆鐘上限。httpx 的 timeout 是**每階段** 3 秒（connect／
# read／write／pool 各自），所以一台惡意種子理論上可以用「每 2.9 秒吐一點」
# 把單一階段一直續命 —— 我們不讀 body（見 `_probe`），再加這條上限當第二
# 道保險：超過就算不可連。
MAX_PROBE_SECONDS = 3.5
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


_Address = Union[ipaddress.IPv4Address, ipaddress.IPv6Address]


def _ip_literal(host: str) -> Optional[_Address]:
    """把一個 URL 主機字串還原成正規的位址物件；認不出來（= DNS 名稱）回
    None。三種字面值都要認得，因為作業系統的 `connect()` 三種都認得：

    - 正規寫法（`10.0.0.1`、`fc00::1`）—— `ipaddress` 直接處理。
    - 非四段十進位的 IPv4（`2130706433`、`0177.0.0.1`、`127.1`）——
      `ipaddress` **不**收，但 `socket.inet_aton` 收，而 `http://2130706433/`
      真的會連到 127.0.0.1。少了這一步，這些寫法會從私有網段靜態拒絕的
      縫隙溜過去。
    - IPv4-mapped IPv6（`::ffff:10.0.0.1`／`::ffff:a00:1`）—— 還原成內含的
      IPv4 再比對，否則它不落在任何一條 IPv6 私有網段裡。
    """
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        try:
            packed = socket.inet_aton(host)
        except OSError:
            return None
        address = ipaddress.ip_address(packed)
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        return address.ipv4_mapped
    return address


def peer_host_address(url: str) -> Optional[_Address]:
    """`url` 主機的正規化位址；主機是 DNS 名稱、或 URL 根本解不開時回 None。"""
    try:
        host = urlsplit(url).hostname
    except ValueError:
        return None
    if not host:
        return None
    return _ip_literal(host)


def is_private_peer_url(url: str) -> bool:
    """`url` 的主機是私有／loopback／link-local 位址。名稱型主機回 False
    —— 我們不在這裡做 DNS 解析（那會變成另一個可被誘導的請求面），而且
    名稱根本不會被探（見 `is_ip_literal_peer_url` 與 `refresh`）。"""
    try:
        host = urlsplit(url).hostname
    except ValueError:
        return True  # URL 解不開（壞掉的 IPv6 括號之類）＝不可能連得到
    if not host:
        return True  # 解不出主機的 URL 本來就不可能連得到
    address = _ip_literal(host)
    if address is None:
        return False
    return any(address in network for network in PRIVATE_NETWORKS)


def is_ip_literal_peer_url(url: str) -> bool:
    """`url` 的主機是 IP 字面值（不是 DNS 名稱）。只有字面值才會被探針驗證
    （fix round 1 裁示）：一個名稱解到哪不是我們能保證的，今天驗過不代表
    下一秒還指向同一台機器。"""
    return peer_host_address(url) is not None


def health_url(peer_url: str) -> str:
    """探針真正打的位址：`peer_url` 去掉結尾斜線再接 `HEALTH_PATH`。也是推給
    agent 的 `peer_status.checked_url`。"""
    return peer_url.rstrip("/") + HEALTH_PATH


def _http_client() -> httpx.Client:
    """探針用的 httpx client。抽成函式只是為了讓測試能塞 `MockTransport`，
    不是為了設定彈性。"""
    return httpx.Client(timeout=httpx.Timeout(TIMEOUT_SECONDS), follow_redirects=False)


def _probe(url: str) -> bool:
    """BLOCKING：對 `url` 發一個 GET，只有 204 算通過。呼叫端一律以
    `asyncio.to_thread` 執行（Global Constraints）。測試 monkeypatch 這個
    函式來模擬 204／timeout。

    **絕不讀 body**：用 `client.stream` 拿到狀態碼就結束 context，httpx 會
    把連線收掉。健康檢查回的是 204（照定義沒有 body），但對面是一台我們不
    信任的機器 —— 它大可回 200 加一個無限長的 body，`client.get()` 會把它
    整個吃進平台的記憶體。狀態碼是我們唯一要的東西。

    再加一道牆鐘上限 `MAX_PROBE_SECONDS`：httpx 的 timeout 是每階段計算的，
    一個慢慢滴資料的對手可以把整趟拉得比 3 秒長；超過就當不可連。
    """
    started = time.monotonic()
    try:
        with _http_client() as client:
            with client.stream("GET", url) as response:
                status = response.status_code
    except Exception:
        return False
    elapsed = time.monotonic() - started
    if elapsed > MAX_PROBE_SECONDS:
        logger.info(
            "peerhealth: probe of %s took %.1fs (> %.1fs), treating as unreachable",
            url,
            elapsed,
            MAX_PROBE_SECONDS,
        )
        return False
    return status == 204


def _utcnow() -> datetime:
    """Naive UTC，與 `agentws._utcnow` 同一個慣例（整個 schema 存的都是
    naive UTC，`dispatch.requeue_stale` 直接拿來比大小）。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _record(
    worker_id: str, reachable: Optional[bool], *, stamp_checked_at: bool = True
) -> Optional[int]:
    """把結論寫進 `workers`，回傳**寫入前**庫裡存的 `peer_reachable`（給
    「只有結論變了才推」的比較用；worker 不存在時一樣回 None）。

    `stamp_checked_at=False` 是「回到完全未檢查」（worker 不再通告
    `peer_url`）：兩欄都清成 NULL。名稱型主機剛好相反 —— 結論留 NULL（我們
    確實沒有結論），但時間戳要蓋，否則 `needs_recheck` 會讓每一拍心跳都白
    跑一次這段。
    """
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        if worker is None:
            return None
        previous = worker.peer_reachable
        worker.peer_reachable = None if reachable is None else int(reachable)
        worker.peer_checked_at = _utcnow() if stamp_checked_at else None
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
            _record(worker_id, None, stamp_checked_at=False)
            return None

        checked_url = health_url(peer_url)
        if not is_private_peer_url(peer_url) and not is_ip_literal_peer_url(peer_url):
            # fix round 1 裁示：名稱型主機不驗（見模組 docstring 第 2 點）。
            # 結論留 NULL ⇒ 這台不是合格種子（`online_seeders` 要
            # `peer_reachable = 1`），但時間戳照蓋，免得每一拍心跳都白跑。
            logger.debug(
                "peerhealth: worker %s advertises a hostname peer_url (%s); not probing",
                worker_id,
                peer_url,
            )
            _record(worker_id, None)
            return None

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
