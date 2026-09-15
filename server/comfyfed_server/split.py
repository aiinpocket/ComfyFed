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
import logging
from dataclasses import dataclass
from typing import Optional

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
    value = inputs.get(field)
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _link_target(value) -> Optional[str]:
    """ComfyUI API 格式的接線是 `[node_id, slot]`；回傳來源 node_id 字串。"""
    if isinstance(value, list) and len(value) >= 1 and isinstance(value[0], (str, int)):
        return str(value[0])
    return None


def _reaches_batch_source(
    node_id: Optional[str], source_node_id: str, by_id: dict[str, tuple[str, dict]], seen: set
) -> bool:
    """沿 LATENT 邊往上追，看看這條 latent 最終是不是那個批次來源。"""
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
            return _reaches_batch_source(_link_target(inputs[field]), source_node_id, by_id, seen)
    return False


def split_plan(
    workflow: dict,
    requirements: Optional[dict] = None,
    split_batches: bool = True,
) -> Optional[SplitPlan]:
    """§3.2：全部五個條件都成立才回傳 `SplitPlan`，否則 `None`。

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
            _link_target(inputs[latent_field]), source_node_id, by_id, set()
        ):
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
            if (
                isinstance(value, list)
                and len(value) >= 2
                and _link_target(value) == plan.source_node_id
                and value[1] == 0
            ):
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
