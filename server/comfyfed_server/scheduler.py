"""Phase 3.3 §2.4-§2.5: 成本模型與整體配對。

全部是純函數：不碰 DB、不讀時鐘（`now` 一律由呼叫端傳進來）。呼叫端
（`dispatch.assign_jobs`）負責把 DB 列翻成這裡的 `JobCandidate` /
`WorkerCandidate` / `PairVerdict`，再把結果翻回去做原子 claim。

兩棧逐行對照 `cloud/src/core/scheduler.ts`；任何一邊改了算式，另一邊必須
同一個 commit 一起改，共用 fixture `cloud/test/fixtures/scheduler_cases.json`
就是用來釘住這件事的。
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime
from typing import Optional, Sequence

from . import assess

LOAD_SEC_PER_GB = 1.5
FETCH_BYTES_PER_SEC = 50e6
STARVE_SECONDS = 300
# 等待超過 STARVE_SECONDS 再多減這麼多，確保只要有合格 worker 一定本 tick 派出。
STARVE_BONUS = 1e8
AGE_WEIGHT = 1.0
BIG = 1e9
WARN_PENALTY = 1_000_000.0
LIGHT_BACKEND_PENALTY = 60.0
LIGHT_VRAM_WEIGHT = 5.0

_WEAK_BACKENDS = ("mps", "cpu")

# Hungarian 內部用的「禁止」哨兵。演算法裡會做 `a[i][j] - u[i] - v[j]` 這種
# 減法，真的塞 `inf` 會冒出 `inf - inf = NaN` 把整個 potential 弄壞，所以禁止
# 的格子換成一個大到絕不會被選中、但仍是有限值的數；選出來之後再回頭對照
# 原始矩陣把禁止格剔掉。
_FORBIDDEN_SENTINEL = 1e18


@dataclass(frozen=True)
class JobCandidate:
    """派工決策需要的 job 欄位，和 ORM 脫鉤。"""

    job_id: str
    signature: Optional[str]
    created_at: datetime
    # 無 required_models 且無 est_vram_gb -- 見 dispatch 的 `is_light`。
    is_light: bool
    required_models: tuple[str, ...]


@dataclass(frozen=True)
class WorkerCandidate:
    worker_id: str
    name: str
    backend: str
    free_vram_gb: float
    # 這台 worker 最近一次被指派的 job 的 required_models（§2.2）。
    warm_models: tuple[str, ...]
    # `assess.model_inventory(worker)` 的結果，用來查模型大小。
    inventory: tuple[dict, ...]


@dataclass(frozen=True)
class PairVerdict:
    """`assess.verdict` 對這一對 (job, worker) 的判定，壓成排程需要的三個值。"""

    kind: str  # "eligible" | "eligible_after_fetch" | "ineligible"
    has_warnings: bool
    total_fetch_bytes: int


def _finite(value) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(float(value))
    )


def load_seconds(job: JobCandidate, worker: WorkerCandidate) -> float:
    """§2.4：這台 worker 還沒熱起來的模型，預估要花多久載進 VRAM。

    大小來自 worker 自己的 `model_inventory`（用 `assess.find_model` 比對，
    因為工作流的模型名和 inventory 路徑根目錄不同）；查不到大小視為 0，
    寧可低估也不要憑空捏一個數字進成本。
    """
    warm = set(worker.warm_models)
    total_gb = 0.0
    for name in job.required_models:
        if name in warm:
            continue
        _found, size_gb = assess.find_model(list(worker.inventory), name)
        if size_gb is not None:
            total_gb += float(size_gb)
    return total_gb * LOAD_SEC_PER_GB


def fetch_seconds(pair: PairVerdict) -> float:
    """§2.4：只有 `eligible_after_fetch` 才會 > 0（頻寬用常數，不量測）。"""
    if pair.kind != "eligible_after_fetch":
        return 0.0
    return float(pair.total_fetch_bytes) / FETCH_BYTES_PER_SEC


def light_penalty(job: JobCandidate, worker: WorkerCandidate) -> float:
    """§2.4：零模型工作落在大卡上要付的代價 -- 把大卡留給真的需要的工作。"""
    if not job.is_light:
        return 0.0
    backend_penalty = 0.0 if worker.backend in _WEAK_BACKENDS else LIGHT_BACKEND_PENALTY
    return backend_penalty + worker.free_vram_gb * LIGHT_VRAM_WEIGHT


def _legacy_tiebreak(job: JobCandidate, worker: WorkerCandidate) -> float:
    """只用來打破完全相等的舊排序鍵：輕工作偏小卡、重工作偏大卡。

    量級刻意做到小於 1 秒（重工作那側甚至小於 1 毫秒），所以它永遠不會蓋過
    任何一項真正的成本，只在兩邊其他每一項都一模一樣時說話。
    """
    if job.is_light:
        return worker.free_vram_gb / 1000.0
    return (1000.0 - worker.free_vram_gb) / 1e6


def cost(
    job: JobCandidate,
    worker: WorkerCandidate,
    pair: PairVerdict,
    predicted_seconds: float,
    tier1_exists: bool,
) -> float:
    """§2.4 的 `cost(j, w)`；不可用一律 `math.inf`。

    `tier1_exists` 是「這個 job 至少有一個 `eligible` 候選」-- 有的話，
    `eligible_after_fetch` 的候選對這個 job 一律視為不可用，保住「已經有模型
    的一定贏過要下載的」這個既有語意。

    任何一項算出 NaN 或負數也回 `inf`：成本本來就不該是負的，出現代表上游
    算錯了，寧可不派也不要讓一個壞值贏過所有合理選擇（spec §5）。
    """
    if pair.kind not in ("eligible", "eligible_after_fetch"):
        return math.inf
    if pair.kind == "eligible_after_fetch" and tier1_exists:
        return math.inf

    components = (
        predicted_seconds,
        load_seconds(job, worker),
        fetch_seconds(pair),
        light_penalty(job, worker),
        WARN_PENALTY if pair.has_warnings else 0.0,
        _legacy_tiebreak(job, worker),
    )
    total = 0.0
    for component in components:
        if not _finite(component) or component < 0:
            return math.inf
        total += float(component)
    return total


def objective(cost_value: float, wait_seconds: float) -> float:
    """§2.5 第 4 條的目標函數項。

    減掉 `BIG` 是為了讓「多派一件」永遠優於「少派一件」：任何一個真實配對的
    目標值都遠低於補零的那些格子，所以 Hungarian 在不違反禁止格的前提下一定
    會盡量多配對。
    """
    if not _finite(cost_value):
        return math.inf
    wait = wait_seconds if _finite(wait_seconds) and wait_seconds > 0 else 0.0
    value = cost_value - AGE_WEIGHT * wait - BIG
    if wait >= STARVE_SECONDS:
        value -= STARVE_BONUS
    return value


def build_matrix(
    jobs: Sequence[JobCandidate],
    workers: Sequence[WorkerCandidate],
    pairs: dict[tuple[str, str], PairVerdict],
    predictions: dict[tuple[str, str], float],
    now: datetime,
) -> list[list[float]]:
    """`matrix[i][j]` = job i 派給 worker j 的目標值；不可用為 `math.inf`。

    `pairs` / `predictions` 以 `(job_id, worker_id)` 為鍵；缺鍵視為不可用／
    使用預設 60 秒（`predictions` 缺鍵只可能是呼叫端漏算，不該讓整個 tick
    掛掉）。
    """
    tier1 = {
        job.job_id: any(
            pairs.get((job.job_id, worker.worker_id), PairVerdict("ineligible", False, 0)).kind
            == "eligible"
            for worker in workers
        )
        for job in jobs
    }

    matrix: list[list[float]] = []
    for job in jobs:
        wait_seconds = (now - job.created_at).total_seconds()
        row: list[float] = []
        for worker in workers:
            pair = pairs.get((job.job_id, worker.worker_id))
            if pair is None:
                row.append(math.inf)
                continue
            predicted = predictions.get((job.job_id, worker.worker_id), 60.0)
            row.append(
                objective(cost(job, worker, pair, predicted, tier1[job.job_id]), wait_seconds)
            )
        matrix.append(row)
    return matrix


def solve(matrix: list[list[float]]) -> list[tuple[int, int]]:
    """最小成本配對（Kuhn–Munkres / Hungarian，O(n³)）。

    長方形輸入會內部補 0 成方陣。非有限值（`inf`、`-inf`、`NaN`）視為禁止，
    最後回傳時剔除；有限負值完全合法（目標函數刻意是負的）。回傳依 row 排序
    的 `(row, col)`，不含補零的行列。

    決定性：在固定的輸入順序下，內層挑 `delta` 用的是嚴格小於，所以平手時
    永遠選欄位索引最小的那個；TS 版逐行相同，因此兩棧同一個矩陣得到同一組
    配對。呼叫端要先把 jobs 依 `(created_at, job_id)`、workers 依
    `(name, worker_id)` 排好，這個保證才有意義。
    """
    rows_n = len(matrix)
    cols_n = max((len(row) for row in matrix), default=0)
    n = max(rows_n, cols_n)
    if n == 0:
        return []

    # 1-indexed 工作矩陣。
    a = [[0.0] * (n + 1) for _ in range(n + 1)]
    for i in range(n):
        for j in range(n):
            value = 0.0
            if i < rows_n and j < len(matrix[i]):
                raw = matrix[i][j]
                value = float(raw) if _finite(raw) else _FORBIDDEN_SENTINEL
            a[i + 1][j + 1] = value

    inf = math.inf
    u = [0.0] * (n + 1)
    v = [0.0] * (n + 1)
    p = [0] * (n + 1)
    way = [0] * (n + 1)

    for i in range(1, n + 1):
        p[0] = i
        j0 = 0
        minv = [inf] * (n + 1)
        used = [False] * (n + 1)
        while True:
            used[j0] = True
            i0 = p[j0]
            delta = inf
            j1 = 0
            for j in range(1, n + 1):
                if used[j]:
                    continue
                cur = a[i0][j] - u[i0] - v[j]
                if cur < minv[j]:
                    minv[j] = cur
                    way[j] = j0
                if minv[j] < delta:
                    delta = minv[j]
                    j1 = j
            for j in range(0, n + 1):
                if used[j]:
                    u[p[j]] += delta
                    v[j] -= delta
                else:
                    minv[j] -= delta
            j0 = j1
            if p[j0] == 0:
                break
        while True:
            j1 = way[j0]
            p[j0] = p[j1]
            j0 = j1
            if j0 == 0:
                break

    result: list[tuple[int, int]] = []
    for j in range(1, n + 1):
        i = p[j]
        if i == 0:
            continue
        row, col = i - 1, j - 1
        if row >= rows_n or col >= cols_n or col >= len(matrix[row]):
            continue
        if not _finite(matrix[row][col]):
            continue
        result.append((row, col))
    result.sort()
    return result


def match(
    jobs: Sequence[JobCandidate],
    workers: Sequence[WorkerCandidate],
    pairs: dict[tuple[str, str], PairVerdict],
    predictions: dict[tuple[str, str], float],
    now: datetime,
) -> list[tuple[int, int]]:
    """`build_matrix` + `solve` 的便利包裝：回傳 `(job index, worker index)`。"""
    return solve(build_matrix(jobs, workers, pairs, predictions, now))
