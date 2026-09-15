"""Phase 3.3 §2.2-§2.4 / §2.6: 每台 worker 跑每種工作有多快。

模組分兩層：上半是完全不碰 DB 的純函數（EWMA、隊伍參考值、speed_index
更新、predict 的 basis ladder），兩棧逐行對照 `cloud/src/core/stats.ts`；
下半是薄薄的 DB adapter。所有 adapter 都吞掉例外只記 log -- 統計壞掉絕不能
影響 job_done 主流程與收據（spec §5）。
"""

from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from . import assess, db

logger = logging.getLogger(__name__)

EWMA_ALPHA = 0.3
SPEED_MIN = 0.1
SPEED_MAX = 10.0
DEFAULT_PREDICTED_SECONDS = 60.0

# §2.6: 回填只重放最近這麼多筆收據，且只做一次。
BACKFILL_LIMIT = 500
BACKFILL_SETTING_KEY = "stats_backfilled"


@dataclass(frozen=True)
class StatRow:
    worker_id: str
    signature: str
    ewma_seconds: float
    samples: int


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def is_valid_exec_seconds(exec_seconds) -> bool:
    """有效樣本：真實、有限、非負的數字。和 `agentws._is_valid_exec_seconds`
    同一組條件，複寫在這裡而不是 import，是為了讓本模組維持可獨立測試的純
    函數層（agentws 會拉進整個 WebSocket 世界）。"""
    return (
        exec_seconds is not None
        and isinstance(exec_seconds, (int, float))
        and not isinstance(exec_seconds, bool)
        and math.isfinite(exec_seconds)
        and exec_seconds >= 0
    )


# --- 純函數層 --------------------------------------------------------------


def median(values: list[float]) -> Optional[float]:
    """偶數個取中間兩個的平均，空的回 None。自己寫而不是用 statistics.median
    是為了和 TS 端逐行對照（TS 沒有標準庫中位數）。"""
    if not values:
        return None
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2.0


def fleet_reference(
    rows: list[StatRow],
    speed_index: dict[str, float],
    signature: str,
    exclude_worker_id: Optional[str],
) -> Optional[float]:
    """§2.3 的 R(sig)：其他 worker 該簽章 `ewma × speed_index` 的中位數。

    乘上 speed_index 是把每台機的觀測值折算回「平均機」的尺度，這樣不同速度
    的機器才能放進同一個中位數比較。沒有其他 worker 的資料時回 None，呼叫端
    據此決定「不更新」或「往下一階 fallback」。
    """
    values = [
        row.ewma_seconds * speed_index.get(row.worker_id, 1.0)
        for row in rows
        if row.signature == signature and row.worker_id != exclude_worker_id
    ]
    return median(values)


def next_ewma(previous: Optional[float], exec_seconds: float) -> float:
    """第一筆樣本直接就是 EWMA 本身；之後 `0.3*exec + 0.7*previous`。"""
    if previous is None:
        return float(exec_seconds)
    return EWMA_ALPHA * float(exec_seconds) + (1.0 - EWMA_ALPHA) * float(previous)


def next_speed_index(current: float, reference: Optional[float], exec_seconds: float) -> float:
    """§2.3 第 2 條：`ratio = R(sig)/exec`，再和現值做同一個 α 的混合後夾住。

    `reference is None`（沒有別人的資料）或 `exec_seconds <= 0`（除不下去）
    一律維持原值 -- 寧可不更新，也不要寫進一個 inf。
    """
    if reference is None or exec_seconds <= 0:
        return current
    ratio = reference / exec_seconds
    blended = EWMA_ALPHA * ratio + (1.0 - EWMA_ALPHA) * current
    return max(SPEED_MIN, min(SPEED_MAX, blended))


def predict(
    rows: list[StatRow],
    speed_index: dict[str, float],
    signature: Optional[str],
    worker_id: str,
) -> tuple[float, str]:
    """§2.4 的四階梯：signature -> speed_index -> fleet_default -> none。

    回傳 `(seconds, basis)`；`basis` 原樣寫進 `jobs.dispatch_info`，console
    就能說明「這個預估是怎麼來的」。
    """
    own_speed = speed_index.get(worker_id, 1.0)
    if not isinstance(own_speed, (int, float)) or own_speed <= 0:
        own_speed = 1.0

    if signature:
        for row in rows:
            if row.worker_id == worker_id and row.signature == signature:
                return row.ewma_seconds, "signature"

        reference = fleet_reference(rows, speed_index, signature, exclude_worker_id=worker_id)
        if reference is not None:
            return reference / own_speed, "speed_index"

    fleet_median = median([row.ewma_seconds for row in rows])
    if fleet_median is not None:
        return fleet_median / own_speed, "fleet_default"

    return DEFAULT_PREDICTED_SECONDS, "none"


# --- DB adapter 層 ---------------------------------------------------------


def load_rows() -> list[StatRow]:
    """整張 `worker_job_stats`。故意一次全讀：一個家用聯邦的 (worker,
    signature) 組合是幾十到幾百列，每個 tick 一次全表讀遠比每對候選跑一次
    查詢便宜，而且讓 `predict` 維持純函數。"""
    try:
        with db.get_session() as session:
            return [
                StatRow(
                    worker_id=row.worker_id,
                    signature=row.signature,
                    ewma_seconds=row.ewma_seconds,
                    samples=row.samples,
                )
                for row in session.query(db.WorkerJobStats).all()
            ]
    except Exception:
        logger.exception("stats: load_rows failed")
        return []


def load_speed_index() -> dict[str, float]:
    try:
        with db.get_session() as session:
            return {
                w.id: (w.speed_index if isinstance(w.speed_index, (int, float)) else 1.0)
                for w in session.query(db.Worker).all()
            }
    except Exception:
        logger.exception("stats: load_speed_index failed")
        return {}


def record_completion(
    worker_id: str, signature: Optional[str], exec_seconds: Optional[float]
) -> None:
    """§2.3：只在 job_done 且 `exec_seconds` 有效時更新。

    失敗只記 log -- 呼叫端（`agentws._handle_job_done`）絕不能因此少發一張
    收據。
    """
    if not signature or not is_valid_exec_seconds(exec_seconds):
        return
    exec_value = float(exec_seconds)

    try:
        with db.get_session() as session:
            rows = [
                StatRow(
                    worker_id=r.worker_id,
                    signature=r.signature,
                    ewma_seconds=r.ewma_seconds,
                    samples=r.samples,
                )
                for r in session.query(db.WorkerJobStats).all()
            ]
            speed_index = {
                w.id: (w.speed_index if isinstance(w.speed_index, (int, float)) else 1.0)
                for w in session.query(db.Worker).all()
            }

            # 1) EWMA。
            existing = session.get(db.WorkerJobStats, (worker_id, signature))
            if existing is None:
                session.add(
                    db.WorkerJobStats(
                        worker_id=worker_id,
                        signature=signature,
                        ewma_seconds=next_ewma(None, exec_value),
                        samples=1,
                        updated_at=_utcnow(),
                    )
                )
            else:
                existing.ewma_seconds = next_ewma(existing.ewma_seconds, exec_value)
                existing.samples = existing.samples + 1
                existing.updated_at = _utcnow()

            # 2) speed_index。參考值算在 EWMA 更新「之前」的快照上，且排除
            #    自己 -- 否則這一筆會同時當觀測值和參考值，自我校正成 1.0。
            worker = session.get(db.Worker, worker_id)
            if worker is not None:
                reference = fleet_reference(
                    rows, speed_index, signature, exclude_worker_id=worker_id
                )
                current = worker.speed_index if isinstance(worker.speed_index, (int, float)) else 1.0
                worker.speed_index = next_speed_index(current, reference, exec_value)

            session.commit()
    except Exception:
        logger.exception(
            "stats: record_completion failed for worker %s signature %s", worker_id, signature
        )


def backfill_if_needed() -> bool:
    """§2.6：第一次啟動時用最近 500 筆完成收據重放一次 `record_completion`。

    回傳「這次有沒有真的跑回填」（旗標已設 -> False）。簽章缺的 job 先由
    `workflow_json` 補算並寫回 `jobs.signature`，所以回填同時也是舊資料的
    簽章補齊通道。
    """
    try:
        with db.get_session() as session:
            flag = session.get(db.Setting, BACKFILL_SETTING_KEY)
            if flag is not None and flag.value == "1":
                return False
            if session.query(db.WorkerJobStats).first() is not None:
                session.add(db.Setting(key=BACKFILL_SETTING_KEY, value="1"))
                session.commit()
                return False

            receipts = (
                session.query(db.Receipt)
                .filter(db.Receipt.kind == "completed", db.Receipt.billable == True)  # noqa: E712
                .order_by(db.Receipt.created_at.desc())
                .limit(BACKFILL_LIMIT)
                .all()
            )
            replay = list(reversed(receipts))  # 依 created_at 由舊到新重放

            pending: list[tuple[str, str, float]] = []
            for receipt in replay:
                if receipt.job_id is None:
                    continue
                job = session.get(db.Job, receipt.job_id)
                if job is None:
                    continue
                signature = job.signature
                if not signature:
                    try:
                        workflow = json.loads(job.workflow_json or "{}")
                    except (TypeError, ValueError):
                        continue
                    if not isinstance(workflow, dict):
                        continue
                    signature = assess.signature(workflow, assess.needs_from_job(job))
                    job.signature = signature
                # `gpu_seconds` 是回填唯一能拿到的執行秒數代理值（收據沒存
                # 原始 exec_seconds；它本身就是 min(exec_seconds, wall)）。
                pending.append((receipt.worker_id, signature, receipt.gpu_seconds))

            session.commit()
    except Exception:
        logger.exception("stats: backfill scan failed")
        return False

    for worker_id, signature, exec_seconds in pending:
        record_completion(worker_id, signature, exec_seconds)

    try:
        with db.get_session() as session:
            flag = session.get(db.Setting, BACKFILL_SETTING_KEY)
            if flag is None:
                session.add(db.Setting(key=BACKFILL_SETTING_KEY, value="1"))
            else:
                flag.value = "1"
            session.commit()
    except Exception:
        logger.exception("stats: failed to set the backfill flag")

    return True
