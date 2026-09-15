"""Phase 3.3 §3: 批次拆分。

本檔上半是純函數（可拆判定、子 workflow 重寫、分片），兩棧逐行對照
`cloud/src/core/split.ts`；下半（Task 6 補上）是父 job 狀態推導與輸出組裝，
那部分要碰 DB。

一致性依據見 spec §3.1：ComfyUI 的 `LatentFromBatch` 會把批次 latent 的
`batch_index` 設起來，`prepare_noise` 因此逐片產生雜訊並只保留指定片，所以
拆出來的第 i 張和整批跑的第 i 張是「同 seed 同構圖」。不是逐位元相同
（batch=2 與 batch=1 的 kernel 路徑浮點差異），差異等同於同一個 job 落在
不同 GPU 上本來就有的差異。
"""

from __future__ import annotations

import copy
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import update

from . import assess, db

logger = logging.getLogger(__name__)

MAX_SPLIT = 8

# §3.2 條件 1：批次來源節點。
BATCH_SOURCE_CLASSES = ("EmptyLatentImage", "EmptySD3LatentImage")

# §3.2 條件 3：白名單，逐字取自 spec。名單外的任何節點（含所有自訂節點、
# ImageBatch / LatentBatch / RepeatLatentBatch / RebatchLatents、影片節點）
# 一律不可拆 -- 這是 allowlist，不是 denylist，新節點預設不可拆。
SPLIT_SAFE_CLASSES = frozenset(
    {
        # 載入
        "CheckpointLoaderSimple",
        "UNETLoader",
        "DualCLIPLoader",
        "TripleCLIPLoader",
        "CLIPLoader",
        "VAELoader",
        "LoraLoader",
        "LoraLoaderModelOnly",
        "ControlNetLoader",
        "UpscaleModelLoader",
        "CLIPVisionLoader",
        "StyleModelLoader",
        "CLIPSetLastLayer",
        # 條件
        "CLIPTextEncode",
        "CLIPTextEncodeSDXL",
        "CLIPTextEncodeFlux",
        "ConditioningCombine",
        "ConditioningConcat",
        "ConditioningSetArea",
        "ConditioningSetAreaPercentage",
        "ConditioningZeroOut",
        "ConditioningSetTimestepRange",
        "FluxGuidance",
        "ControlNetApply",
        "ControlNetApplyAdvanced",
        # 模型調整
        "ModelSamplingFlux",
        "ModelSamplingSD3",
        "ModelSamplingDiscrete",
        # 取樣
        "KSampler",
        "KSamplerAdvanced",
        "SamplerCustom",
        "SamplerCustomAdvanced",
        "RandomNoise",
        "KSamplerSelect",
        "BasicScheduler",
        "BasicGuider",
        "CFGGuider",
        "DisableNoise",
        # Latent / 影像
        "EmptyLatentImage",
        "EmptySD3LatentImage",
        "VAEDecode",
        "VAEDecodeTiled",
        "VAEEncode",
        "VAEEncodeForInpaint",
        "SetLatentNoiseMask",
        "LatentUpscale",
        "LatentUpscaleBy",
        "ImageScale",
        "ImageScaleBy",
        "ImageUpscaleWithModel",
        "ImageInvert",
        "ImageCrop",
        "ImagePadForOutpaint",
        "LoadImage",
        "LoadImageMask",
        "SaveImage",
        "PreviewImage",
    }
)

# §3.2 條件 4：沿 LATENT 邊往上追時，允許「原封不動傳遞 latent 批次結構」的
# 中繼節點。VAEEncode 之類「從別的型別造出 latent」的節點刻意不在這裡 --
# 追到它就代表這條 latent 不是來自批次來源，判定為不可拆。
_LATENT_PASSTHROUGH_CLASSES = frozenset(
    {
        "LatentUpscale",
        "LatentUpscaleBy",
        "SetLatentNoiseMask",
        # 取樣器本身也算：refiner 鏈（KSampler -> KSamplerAdvanced）的第二段
        # 吃的是第一段的輸出 latent，批次結構原樣傳下去。
        "KSampler",
        "KSamplerAdvanced",
        "SamplerCustom",
        "SamplerCustomAdvanced",
    }
)

# 取樣器吃 latent 的輸入欄位名。ComfyUI 核心在這兩個名字之間並不統一
# （KSampler 是 latent_image，LatentUpscale/VAEDecode 是 samples）。
_LATENT_INPUT_FIELDS = ("latent_image", "samples")

# §3.2 條件 6：輸出節點。每一個都必須以批次來源為祖先，否則一條跟批次無關
# 的側支線（例如 LoadImage -> VAEEncode -> VAEDecode -> SaveImage）會在每個
# 子 workflow 都跑一次，輸出在父 job 被複製 k 份。
_OUTPUT_CLASSES = frozenset({"SaveImage", "PreviewImage"})

_SPLIT_NODE_ID = "cfsplit"


@dataclass(frozen=True)
class SplitPlan:
    source_node_id: str
    batch_size: int


def _nodes(workflow) -> list[tuple[str, str, dict]]:
    """`(node_id, class_type, inputs)`，跳過任何形狀不對的節點。"""
    result = []
    for node_id, node in (workflow or {}).items():
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type")
        if not isinstance(class_type, str):
            continue
        inputs = node.get("inputs")
        result.append((str(node_id), class_type, inputs if isinstance(inputs, dict) else {}))
    return result


def _literal_int(inputs: dict, field: str) -> Optional[int]:
    """字面整數。JSON 沒有 int/float 之分，`4.0` 這種整數值的 float 也要收
    （TS 那邊 JS 數字本來就沒有這個區分，兩棧才會對齊）；`bool` 是 `int` 的
    子類別，要先排除。"""
    value = inputs.get(field)
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def _link_target(value) -> Optional[str]:
    """ComfyUI API 格式的接線是 `[node_id, slot]`；回傳來源 node_id 字串，
    不論 slot 是多少。用於條件 6 的祖先追溯（那邊刻意忽略 slot）。"""
    if isinstance(value, list) and len(value) >= 1 and isinstance(value[0], (str, int)):
        return str(value[0])
    return None


def _link_target_slot0(value) -> Optional[str]:
    """跟 `_link_target` 一樣，但只有接線指向 slot 0 才算數。條件 4 的 latent
    追溯要用這個 -- 接到 `[source, 1]`（來源節點的第二個輸出）不算追到批次
    來源，因為那不是 `LatentFromBatch` 會重寫的那個輸出槽。"""
    if (
        isinstance(value, list)
        and len(value) >= 2
        and isinstance(value[0], (str, int))
        and isinstance(value[1], int)
        and not isinstance(value[1], bool)
        and value[1] == 0
    ):
        return str(value[0])
    return None


def _reaches_batch_source(
    node_id: Optional[str], source_node_id: str, by_id: dict[str, tuple[str, dict]], seen: set
) -> bool:
    """沿 LATENT 邊往上追（只走 slot 0），看看這條 latent 最終是不是那個批次
    來源。"""
    if node_id is None or node_id in seen:
        return False
    seen.add(node_id)
    if node_id == source_node_id:
        return True
    entry = by_id.get(node_id)
    if entry is None:
        return False
    class_type, inputs = entry
    if class_type not in _LATENT_PASSTHROUGH_CLASSES:
        return False
    for field in _LATENT_INPUT_FIELDS:
        if field in inputs:
            return _reaches_batch_source(
                _link_target_slot0(inputs[field]), source_node_id, by_id, seen
            )
    return False


def _has_ancestor(
    node_id: Optional[str], source_node_id: str, by_id: dict[str, tuple[str, dict]], seen: set
) -> bool:
    """條件 6：由 `node_id` 沿著它的**所有** inputs 接線往上走（忽略 slot，
    不限 LATENT 欄位），看看走不走得到 `source_node_id`。用來確認輸出節點
    真的是批次來源的下游，而不是一條跟批次無關的側支線。"""
    if node_id is None or node_id in seen:
        return False
    seen.add(node_id)
    if node_id == source_node_id:
        return True
    entry = by_id.get(node_id)
    if entry is None:
        return False
    _class_type, inputs = entry
    for value in inputs.values():
        parent_id = _link_target(value)
        if parent_id is not None and _has_ancestor(parent_id, source_node_id, by_id, seen):
            return True
    return False


def split_plan(
    workflow: dict,
    requirements: Optional[dict] = None,
    split_batches: bool = True,
) -> Optional[SplitPlan]:
    """§3.2：全部六個條件都成立才回傳 `SplitPlan`，否則 `None`。

    `requirements` 是 job 的 `requirements` dict（`split` 為 `False` 時關閉
    這一件的拆分）；`split_batches` 是平台設定（預設開）。兩個都帶預設值，
    所以純測試可以只餵 workflow。
    """
    if not split_batches:
        return None
    if isinstance(requirements, dict) and requirements.get("split") is False:
        return None

    nodes = _nodes(workflow)
    if not nodes:
        return None

    by_id = {node_id: (class_type, inputs) for node_id, class_type, inputs in nodes}

    # 條件 1：恰好一個批次來源，`batch_size` 是字面 int >= 2。
    sources = [
        (node_id, batch)
        for node_id, class_type, inputs in nodes
        if class_type in BATCH_SOURCE_CLASSES
        and (batch := _literal_int(inputs, "batch_size")) is not None
        and batch >= 2
    ]
    if len(sources) != 1:
        return None
    source_node_id, batch_size = sources[0]

    # 條件 2：沒有其他節點帶 `batch_size` 輸入（不論值）。
    for node_id, _class_type, inputs in nodes:
        if node_id != source_node_id and "batch_size" in inputs:
            return None

    # 條件 3：每個節點的 class_type 都在白名單。
    for _node_id, class_type, _inputs in nodes:
        if class_type not in SPLIT_SAFE_CLASSES:
            return None

    # 條件 4：每個吃 latent 的取樣器都追得到那個批次來源。
    for node_id, class_type, inputs in nodes:
        if not (class_type.startswith("KSampler") or class_type.startswith("SamplerCustom")):
            continue
        latent_field = next((f for f in _LATENT_INPUT_FIELDS if f in inputs), None)
        if latent_field is None:
            # KSamplerSelect 之類根本不吃 latent 的節點：不是 latent 消費者。
            continue
        if not _reaches_batch_source(
            _link_target_slot0(inputs[latent_field]), source_node_id, by_id, set()
        ):
            return None

    # 條件 6：每個輸出節點都要以批次來源為祖先。
    for node_id, class_type, _inputs in nodes:
        if class_type not in _OUTPUT_CLASSES:
            continue
        if not _has_ancestor(node_id, source_node_id, by_id, set()):
            return None

    return SplitPlan(source_node_id=source_node_id, batch_size=batch_size)


def _free_split_node_id(workflow: dict) -> str:
    if _SPLIT_NODE_ID not in workflow:
        return _SPLIT_NODE_ID
    index = 1
    while f"{_SPLIT_NODE_ID}_{index}" in workflow:
        index += 1
    return f"{_SPLIT_NODE_ID}_{index}"


def child_workflow(
    workflow: dict, plan: SplitPlan, start: int, length: int
) -> Optional[dict]:
    """§3.3：深拷貝原圖，插入一個 `LatentFromBatch`，把所有原本引用
    `[source_node_id, 0]` 的輸入改指向它。

    來源節點本身的 `batch_size` **不改**：EmptyLatent 幾乎零成本，而
    `LatentFromBatch` 需要整批 shape 才能算對是哪一片。

    找不到任何引用來源節點的輸入時回 `None` 並記 WARNING（理論上被 §3.2
    條件 4 擋掉，見 spec §5）。
    """
    child = copy.deepcopy(workflow)
    split_node_id = _free_split_node_id(child)

    rewired = 0
    for _node_id, node in child.items():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for field, value in list(inputs.items()):
            if _link_target_slot0(value) == plan.source_node_id:
                inputs[field] = [split_node_id, 0]
                rewired += 1

    if rewired == 0:
        logger.warning(
            "split: no input references batch source node %s; refusing to split",
            plan.source_node_id,
        )
        return None

    child[split_node_id] = {
        "class_type": "LatentFromBatch",
        "inputs": {
            "samples": [plan.source_node_id, 0],
            "batch_index": start,
            "length": length,
        },
    }
    return child


def partition(batch_size: int, k: int) -> list[tuple[int, int]]:
    """§3.3 的分片：k 段連續範圍，前 `B mod k` 段長 `ceil(B/k)`，其餘
    `floor(B/k)`。回傳 `[(start, length), ...]`，`split_index` 就是索引。

    `k` 會先夾在 `1..min(batch_size, MAX_SPLIT)`，所以呼叫端不必自己防呆。
    """
    k = max(1, min(k, batch_size, MAX_SPLIT))
    base, remainder = divmod(batch_size, k)
    ranges: list[tuple[int, int]] = []
    start = 0
    for index in range(k):
        length = base + (1 if index < remainder else 0)
        ranges.append((start, length))
        start += length
    return ranges


# --- DB 層（§3.4-§3.6）-----------------------------------------------------

SPLIT_BATCHES_SETTING_KEY = "split_batches"

# 子 job 被兄弟拖著一起收攤時寫進 `error` 的理由（`_cancel_sibling`）。
_SIBLING_FAILED_REASON = "sibling failed"
_SIBLING_CANCELLED_REASON = "sibling cancelled"

# 還沒終止、因此會被串聯取消掃到的狀態。
_LIVE_STATUSES = ("queued", "assigned", "running")

# 父 job 一旦落在這些狀態就不再由子 job 推導（見 `refresh_parent`）。和
# `dispatch._TERMINAL_STATUSES` 同一組，這裡重寫一份而不是 import dispatch --
# dispatch 已經 import 了 split，反過來會成為循環。
_TERMINAL_STATUSES = ("done", "failed", "cancelled")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def split_batches_enabled(session=None) -> bool:
    """平台設定 `split_batches`（預設 true）。任何非 `"0"` 的值都算開啟，
    和其他 boolean 設定的寬鬆讀法一致；讀不到（沒有這一列、DB 還沒初始化）
    就是預設開。"""

    def _read(s) -> bool:
        row = s.get(db.Setting, SPLIT_BATCHES_SETTING_KEY)
        return True if row is None else row.value != "0"

    if session is not None:
        return _read(session)
    try:
        with db.get_session() as own:
            return _read(own)
    except Exception:
        logger.exception("split: failed to read the split_batches setting")
        return True


def plan_for_job(workflow: dict, requirements: Optional[dict]) -> Optional[str]:
    """送件時算一次，回傳要存進 `jobs.split_plan` 的 JSON 字串（不可拆 =
    None）。存字串而不是存物件，是因為這一欄大多數時候沒人看，解析成本應該
    留給真的要用的人（tick 的拆分步驟）。"""
    plan = split_plan(workflow, requirements, split_batches_enabled())
    if plan is None:
        return None
    return json.dumps({"source_node_id": plan.source_node_id, "batch_size": plan.batch_size})


def _plan_from_json(raw: Optional[str]) -> Optional[SplitPlan]:
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    source_node_id = data.get("source_node_id")
    batch_size = data.get("batch_size")
    if not isinstance(source_node_id, str) or not isinstance(batch_size, int) or batch_size < 2:
        return None
    return SplitPlan(source_node_id=source_node_id, batch_size=batch_size)


def children_of(parent_id: str) -> list["db.Job"]:
    """`parent_id` 的子 job，依 `split_index` 排序。"""
    with db.get_session() as session:
        return (
            session.query(db.Job)
            .filter(db.Job.parent_id == parent_id)
            .order_by(db.Job.split_index.asc())
            .all()
        )


def create_children(parent_id: str, k: int) -> int:
    """§3.3 + §3.5：在同一個交易裡插入 k 個子 job 並把父 job 的
    `split_count` 設成 k。回傳實際建立的子 job 數，0 代表沒拆。

    父 job 的標記是一個條件 UPDATE（`WHERE status='queued' AND
    split_count=0`，和 `dispatch.assign_jobs` 的原子 claim 同一個形狀），所以
    兩個 tick 同時看到同一件 queued 父 job 時，只有一個會真的拆。

    交易失敗 -> 父 job 維持原狀（`split_count` 仍 0），本 tick 當作不可拆
    處理，下個 tick 重試（spec §5）。
    """
    try:
        with db.get_session() as session:
            parent = session.get(db.Job, parent_id)
            if parent is None or parent.status != "queued" or parent.split_count != 0:
                return 0
            plan = _plan_from_json(parent.split_plan)
            if plan is None:
                return 0

            try:
                workflow = json.loads(parent.workflow_json or "{}")
            except (TypeError, ValueError):
                return 0
            if not isinstance(workflow, dict):
                return 0

            try:
                parent_nodes = json.loads(parent.required_nodes or "[]")
            except (TypeError, ValueError):
                parent_nodes = []
            if not isinstance(parent_nodes, list):
                parent_nodes = []
            # 子 workflow 多了一個 `LatentFromBatch`，資格判定（§2.3 的
            # required_nodes 檢查）必須看得到它，否則子 job 會被派給一台其實
            # 跑不動它的 worker。
            child_nodes = json.dumps(sorted(set(parent_nodes) | {"LatentFromBatch"}))

            ranges = partition(plan.batch_size, k)
            children = []
            for index, (start, length) in enumerate(ranges):
                child_json = child_workflow(workflow, plan, start, length)
                if child_json is None:
                    return 0
                children.append(
                    db.Job(
                        workflow_json=json.dumps(child_json),
                        status="queued",
                        # 承襲父 job，保住在佇列中的位置與派工資格判定。
                        created_at=parent.created_at,
                        signature=parent.signature,
                        required_nodes=child_nodes,
                        required_models=parent.required_models,
                        est_vram_gb=parent.est_vram_gb,
                        requirements=parent.requirements,
                        input_assets=parent.input_assets,
                        origin=parent.origin,
                        user_id=parent.user_id,
                        parent_id=parent.id,
                        split_index=index,
                    )
                )

            # 原子護欄先行：搶輸了（rowcount 0）就一個子 job 都不插。
            result = session.execute(
                update(db.Job)
                .where(
                    db.Job.id == parent_id,
                    db.Job.status == "queued",
                    db.Job.split_count == 0,
                )
                .values(split_count=len(children))
            )
            if result.rowcount != 1:
                session.rollback()
                return 0

            for child in children:
                session.add(child)
            session.commit()
            return len(children)
    except Exception:
        logger.exception("split: create_children failed for parent %s", parent_id)
        return 0


def create_children_for_tick(
    session,
    queued_jobs: list,
    workers: list,
    all_workers: list,
    fetchable_models: Optional[dict] = None,
    peer_only_models=None,
) -> bool:
    """§3.5：tick 第 2 步與第 3 步之間的拆分決策。回傳有沒有真的拆出東西。

    ```
    consumed = 0
    for j in queued（舊到新）:
        E = 對 j 合格的 idle worker 集合
        if j 不可拆: if E 非空: consumed += 1; continue
        S = |E| - consumed
        k = min(batch_size, S, MAX_SPLIT)
        if k >= 2: 拆成 k 個子 job; consumed += k
        elif E 非空: consumed += 1
    ```

    `consumed` 是「前面的 job 大概會用掉幾台 worker」的估計而不是精確保留 --
    真正的配對是後面的 Hungarian 在做，這裡寧可少拆不多拆。
    """
    total_workers = len(workers)
    consumed = 0
    split_any = False

    for job in queued_jobs:
        try:
            requirements_override = json.loads(job.requirements or "{}")
        except (TypeError, ValueError):
            requirements_override = {}
        if not isinstance(requirements_override, dict):
            requirements_override = {}
        needs = assess.needs_from_job(job)
        eligible = sum(
            1
            for worker in workers
            if assess.verdict(
                worker, needs, requirements_override, all_workers, fetchable_models, peer_only_models
            ).kind
            in ("eligible", "eligible_after_fetch")
        )

        plan = _plan_from_json(job.split_plan)
        if plan is None:
            if eligible > 0:
                consumed += 1
            continue

        available = min(eligible, total_workers) - consumed
        k = min(plan.batch_size, available, MAX_SPLIT)
        if k >= 2:
            # 這個 session 已經讀過這些列，先 commit 再讓 create_children 開它
            # 自己的 session，免得兩個 session 同時想寫同一列。
            session.commit()
            created = create_children(job.id, k)
            if created >= 2:
                consumed += created
                split_any = True
                continue
        if eligible > 0:
            consumed += 1

    return split_any


def refresh_parent(
    parent_id: str, cancelled_owners: Optional[list[tuple[str, str]]] = None
) -> tuple[bool, Optional[str]]:
    """§3.4：由子 job 推導父 job 的狀態，回傳 `(有沒有變, 新狀態)`。

    `split_count == 0`（不是父 job，或重試後被重設）一律回 `(False, None)`，
    這是「重試一律不再拆」的那條規則的實作點：所有以父 job 推導的函數都只在
    `split_count > 0` 時看子 job。

    `cancelled_owners`，給了的話，會被 append 上這一次串聯取消掉的
    `(child_id, worker_id)` -- 只收取消當下真的有 owner 的那些，讓呼叫端
    （WS 層）可以對那台 worker 推一次 `job_cancelled`。給 None（預設）代表
    呼叫端不打算推，取消照樣發生。
    """
    with db.get_session() as session:
        parent = session.get(db.Job, parent_id)
        if parent is None or parent.split_count <= 0:
            return False, None
        # 父 job 一旦終止就不再由子 job 推導：一個遲到的子 job 回報（被取消的
        # worker 還是把 job_done 送上來了、或是取消之後才落地的 mark_failed）
        # 絕不能把已經 cancelled/failed/done 的父 job 又搬回去。這也讓整個推導
        # 是冪等的 -- 第二個子 job 失敗時不會再串聯取消一次。
        if parent.status in _TERMINAL_STATUSES:
            return False, None

        children = (
            session.query(db.Job)
            .filter(db.Job.parent_id == parent_id)
            .order_by(db.Job.split_index.asc())
            .all()
        )
        if not children:
            return False, None

        total = len(children)
        statuses = [c.status for c in children]
        before = (
            parent.status,
            parent.progress,
            parent.started_at,
            parent.finished_at,
            parent.error,
            parent.worker_id,
        )
        cascade_cancel_ids: list[str] = []
        cascade_reason = _SIBLING_FAILED_REASON

        failed = next((c for c in children if c.status == "failed"), None)
        cancelled = next((c for c in children if c.status == "cancelled"), None)

        if failed is not None:
            parent.status = "failed"
            parent.error = f"子任務 {(failed.split_index or 0) + 1}/{total}：{failed.error or ''}"
            parent.finished_at = parent.finished_at or _utcnow()
            cascade_cancel_ids = [c.id for c in children if c.status in _LIVE_STATUSES]
        elif cancelled is not None:
            parent.status = "cancelled"
            parent.error = cancelled.error
            parent.finished_at = parent.finished_at or _utcnow()
            # 兄弟收到的理由就是這一次取消的理由（admin 的「cancelled by
            # admin」、面板的「interrupted from panel」…），不是一句沒有資訊的
            # 「sibling cancelled」-- 面板上每個子 job 顯示的都該是同一個原因。
            cascade_reason = cancelled.error or _SIBLING_CANCELLED_REASON
            cascade_cancel_ids = [c.id for c in children if c.status in _LIVE_STATUSES]
        elif all(s == "done" for s in statuses):
            parent.status = "done"
            finishes = [c.finished_at for c in children if c.finished_at is not None]
            parent.finished_at = max(finishes) if finishes else _utcnow()
            parent.progress = 1.0
        elif any(s == "running" for s in statuses):
            parent.status = "running"
            starts = [c.started_at for c in children if c.started_at is not None]
            if starts:
                parent.started_at = min(starts)
            parent.progress = sum(c.progress or 0.0 for c in children) / total
        elif any(s == "assigned" for s in statuses):
            parent.status = "assigned"
            # 父 job 從來沒有自己的 worker：它的工作分散在子 job 身上。
            parent.worker_id = None
        else:
            parent.status = "queued"
            parent.progress = 0.0

        after = (
            parent.status,
            parent.progress,
            parent.started_at,
            parent.finished_at,
            parent.error,
            parent.worker_id,
        )
        changed = before != after
        new_status = parent.status
        session.commit()

    for child_id in cascade_cancel_ids:
        owner = _cancel_sibling(child_id, cascade_reason)
        if owner is not None and cancelled_owners is not None:
            cancelled_owners.append((child_id, owner))

    return changed, new_status


def _cancel_sibling(child_id: str, reason: str) -> Optional[str]:
    """取消一個還沒終止的兄弟子 job；回傳取消當下持有它的 worker id（沒有人
    持有就是 None）。

    刻意**不**走 `dispatch.cancel_job`：那個函式尾端會呼叫
    `child_status_changed` -> `refresh_parent`，而我們正是從 `refresh_parent`
    裡呼叫過來的，會變成互相遞迴。這裡直接寫欄位，寫的是和 `cancel_job`
    一模一樣的一組（status/error/finished_at/last_worker_id/worker_id），父
    job 的狀態由外層那一次 `refresh_parent` 負責，不需要再觸發一次。

    所有權的釋放（`worker_id = None`、`last_worker_id` 留底）是載重的，理由
    見 `dispatch.cancel_job` 的 docstring：即使呼叫端沒推成 `job_cancelled`，
    那台 worker 之後的每一次心跳／回報都會落在 not-owned 路徑，由那裡補推
    一次。
    """
    with db.get_session() as session:
        child = session.get(db.Job, child_id)
        if child is None or child.status not in _LIVE_STATUSES:
            return None
        owning_worker_id = child.worker_id
        child.status = "cancelled"
        child.error = reason
        child.finished_at = _utcnow()
        if owning_worker_id is not None:
            child.last_worker_id = owning_worker_id
            child.worker_id = None
        session.commit()
    return owning_worker_id


def child_status_changed(
    job_id: str, cancelled_owners: Optional[list[tuple[str, str]]] = None
) -> Optional[str]:
    """子 job 狀態／進度變動後的統一入口。

    不是子 job（沒有 `parent_id`）或父 job 已經不是父 job（`split_count == 0`）
    就什麼都不做並回 None；否則重算父 job 並回傳父 job 的新狀態，讓呼叫端
    決定要不要對面板／console 發事件。`cancelled_owners` 原樣傳給
    `refresh_parent`，見那裡的說明。
    """
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        parent_id = job.parent_id if job is not None else None
    if not parent_id:
        return None
    _changed, status = refresh_parent(parent_id, cancelled_owners=cancelled_owners)
    return status


def refresh_parent_progress(job_id: str) -> Optional[float]:
    """§3.4：子 job 回報進度之後，把父 job 的 `progress` 更新成子 job 的平均。

    和 `refresh_parent` 分開的原因是呼叫頻率：進度來自心跳（每個子 job 每 30
    秒一次，跑的時候更密），而狀態推導要跑串聯取消、要寫五六個欄位。這裡只做
    一次子 job 查詢加一次 UPDATE，狀態一個字都不碰。

    不是子 job、父 job 已經不是父 job（`split_count == 0`）、或父 job 已經終止
    （遲到的心跳不該把 progress 從 1.0 拉回去）就什麼都不做並回 None；否則回
    傳父 job 的新 progress。

    刻意**不**發面板事件 -- 那是 Task 7 的事。
    """
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        parent_id = job.parent_id if job is not None else None
        if not parent_id:
            return None

        parent = session.get(db.Job, parent_id)
        if parent is None or parent.split_count <= 0 or parent.status in _TERMINAL_STATUSES:
            return None

        children = session.query(db.Job).filter(db.Job.parent_id == parent_id).all()
        if not children:
            return None

        progress = sum(c.progress or 0.0 for c in children) / len(children)
        if parent.progress != progress:
            parent.progress = progress
            session.commit()
        return progress


def parent_outputs(parent) -> list[tuple[str, str]]:
    """§3.4：父 job 對外的輸出 = 子 job 的 `result_files`，依 `split_index`
    再依各自檔案順序串起來，因此和整批一次跑的輸出順序一致。

    回傳 `[(child_id, filename), ...]` -- child_id 是面板 `/view` 用來找到
    真正持有檔案的那個 job 的 `subfolder`。
    """
    if parent is None or (parent.split_count or 0) <= 0:
        return []
    outputs: list[tuple[str, str]] = []
    for child in children_of(parent.id):
        try:
            files = json.loads(child.result_files or "[]")
        except (TypeError, ValueError):
            files = []
        if not isinstance(files, list):
            continue
        for name in files:
            if isinstance(name, str):
                outputs.append((child.id, name))
    return outputs
