"""Unit tests for split.py -- Phase 3.3 §3.2 的每一個否決條件、§3.3 的子
workflow 重寫與分片。全部是純函數，不需要 DB。
"""

import copy

import pytest

from comfyfed_server import split


def _batch_workflow(batch_size=4, extra=None):
    """一張最小但完整可拆的圖：loader -> 條件 -> EmptyLatentImage -> KSampler
    -> VAEDecode -> SaveImage。"""
    workflow = {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "a.safetensors"}},
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "wuxia", "clip": ["1", 1]}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["1", 1]}},
        "4": {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": 512, "height": 512, "batch_size": batch_size},
        },
        "5": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["1", 0],
                "positive": ["2", 0],
                "negative": ["3", 0],
                "latent_image": ["4", 0],
                "steps": 20,
                "seed": 424242,
            },
        },
        "6": {"class_type": "VAEDecode", "inputs": {"samples": ["5", 0], "vae": ["1", 2]}},
        "7": {"class_type": "SaveImage", "inputs": {"images": ["6", 0]}},
    }
    if extra:
        workflow.update(copy.deepcopy(extra))
    return workflow


# --- §3.2 可拆判定 ---------------------------------------------------------


def test_split_plan_accepts_a_clean_batch_workflow():
    plan = split.split_plan(_batch_workflow(batch_size=4))
    assert plan == split.SplitPlan(source_node_id="4", batch_size=4)


def test_split_plan_vetoes_batch_size_one():
    assert split.split_plan(_batch_workflow(batch_size=1)) is None


def test_split_plan_vetoes_a_non_literal_batch_size():
    workflow = _batch_workflow()
    workflow["4"]["inputs"]["batch_size"] = ["9", 0]
    assert split.split_plan(workflow) is None


def test_split_plan_vetoes_two_batch_sources():
    workflow = _batch_workflow()
    workflow["8"] = {
        "class_type": "EmptyLatentImage",
        "inputs": {"width": 512, "height": 512, "batch_size": 2},
    }
    assert split.split_plan(workflow) is None


def test_split_plan_vetoes_any_other_node_carrying_batch_size():
    workflow = _batch_workflow()
    workflow["8"] = {"class_type": "KSampler", "inputs": {"batch_size": 1, "latent_image": ["4", 0]}}
    assert split.split_plan(workflow) is None


def test_split_plan_vetoes_a_node_outside_the_whitelist():
    workflow = _batch_workflow()
    workflow["8"] = {"class_type": "SomeCustomNode", "inputs": {}}
    assert split.split_plan(workflow) is None


@pytest.mark.parametrize("class_type", ["ImageBatch", "LatentBatch", "RepeatLatentBatch", "RebatchLatents"])
def test_split_plan_vetoes_the_explicitly_named_batch_nodes(class_type):
    workflow = _batch_workflow()
    workflow["8"] = {"class_type": class_type, "inputs": {}}
    assert split.split_plan(workflow) is None


def test_split_plan_vetoes_a_sampler_whose_latent_does_not_come_from_the_batch_source():
    workflow = _batch_workflow()
    # 另一條 latent 來源：VAEEncode 從影像編碼出來的 latent，追不到批次來源。
    workflow["8"] = {"class_type": "LoadImage", "inputs": {"image": "x.png"}}
    workflow["9"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["8", 0], "vae": ["1", 2]}}
    workflow["5"]["inputs"]["latent_image"] = ["9", 0]
    assert split.split_plan(workflow) is None


def test_split_plan_allows_a_latent_passthrough_chain_to_the_batch_source():
    workflow = _batch_workflow()
    workflow["8"] = {"class_type": "LatentUpscale", "inputs": {"samples": ["4", 0]}}
    workflow["5"]["inputs"]["latent_image"] = ["8", 0]
    assert split.split_plan(workflow) == split.SplitPlan(source_node_id="4", batch_size=4)


def test_split_plan_allows_a_refiner_chain_of_two_samplers():
    workflow = _batch_workflow()
    workflow["8"] = {
        "class_type": "KSamplerAdvanced",
        "inputs": {"model": ["1", 0], "latent_image": ["5", 0], "steps": 10},
    }
    workflow["6"]["inputs"]["samples"] = ["8", 0]
    assert split.split_plan(workflow) == split.SplitPlan(source_node_id="4", batch_size=4)


def test_split_plan_ignores_ksampler_select_which_has_no_latent_input():
    workflow = _batch_workflow()
    workflow["8"] = {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}}
    assert split.split_plan(workflow) == split.SplitPlan(source_node_id="4", batch_size=4)


def test_split_plan_vetoes_when_requirements_say_no():
    assert split.split_plan(_batch_workflow(), requirements={"split": False}) is None
    assert split.split_plan(_batch_workflow(), requirements={"split": True}) is not None
    assert split.split_plan(_batch_workflow(), requirements={}) is not None


def test_split_plan_vetoes_when_the_platform_setting_is_off():
    assert split.split_plan(_batch_workflow(), split_batches=False) is None


def test_split_plan_handles_a_junk_workflow_without_raising():
    assert split.split_plan({}) is None
    assert split.split_plan({"1": "not a dict"}) is None
    assert split.split_plan({"1": {"class_type": 7, "inputs": {}}}) is None


# --- §3.3 子 workflow 重寫 -------------------------------------------------


def test_child_workflow_inserts_latent_from_batch_and_rewires_consumers():
    workflow = _batch_workflow(batch_size=4)
    plan = split.split_plan(workflow)

    child = split.child_workflow(workflow, plan, start=2, length=2)

    assert child["cfsplit"] == {
        "class_type": "LatentFromBatch",
        "inputs": {"samples": ["4", 0], "batch_index": 2, "length": 2},
    }
    assert child["5"]["inputs"]["latent_image"] == ["cfsplit", 0]
    # 來源節點本身的 batch_size 不改：LatentFromBatch 需要整批 shape 才能算對片。
    assert child["4"]["inputs"]["batch_size"] == 4
    # 原圖不被就地修改。
    assert workflow["5"]["inputs"]["latent_image"] == ["4", 0]


def test_child_workflow_picks_a_free_node_id_when_cfsplit_is_taken():
    workflow = _batch_workflow()
    workflow["cfsplit"] = {"class_type": "PreviewImage", "inputs": {"images": ["6", 0]}}
    plan = split.split_plan(workflow)

    child = split.child_workflow(workflow, plan, start=0, length=2)

    assert child["cfsplit"]["class_type"] == "PreviewImage"
    assert child["cfsplit_1"]["class_type"] == "LatentFromBatch"
    assert child["5"]["inputs"]["latent_image"] == ["cfsplit_1", 0]


def test_child_workflow_rewires_every_consumer_of_the_source():
    workflow = _batch_workflow()
    workflow["8"] = {"class_type": "LatentUpscale", "inputs": {"samples": ["4", 0]}}
    plan = split.split_plan(workflow)

    child = split.child_workflow(workflow, plan, start=1, length=1)

    assert child["5"]["inputs"]["latent_image"] == ["cfsplit", 0]
    assert child["8"]["inputs"]["samples"] == ["cfsplit", 0]


def test_child_workflow_returns_none_when_nothing_references_the_source():
    """理論上被 §3.2 條件 4 擋掉；真的發生就不拆（spec §5）。"""
    workflow = _batch_workflow()
    plan = split.SplitPlan(source_node_id="no-such-node", batch_size=4)
    assert split.child_workflow(workflow, plan, start=0, length=2) is None


# --- §3.3 分片 -------------------------------------------------------------


def test_partition_splits_evenly_when_it_divides():
    assert split.partition(4, 2) == [(0, 2), (2, 2)]
    assert split.partition(8, 4) == [(0, 2), (2, 2), (4, 2), (6, 2)]


def test_partition_gives_the_remainder_to_the_first_children():
    assert split.partition(5, 2) == [(0, 3), (3, 2)]
    assert split.partition(7, 3) == [(0, 3), (3, 2), (5, 2)]


def test_partition_covers_the_whole_batch_exactly_once():
    for batch_size in range(2, 20):
        for k in range(2, min(batch_size, split.MAX_SPLIT) + 1):
            ranges = split.partition(batch_size, k)
            assert len(ranges) == k
            assert ranges[0][0] == 0
            covered = []
            for start, length in ranges:
                assert length >= 1
                covered.extend(range(start, start + length))
            assert covered == list(range(batch_size))


def test_partition_with_k_one_is_the_whole_batch():
    assert split.partition(4, 1) == [(0, 4)]


def test_partition_clamps_k_to_the_batch_size():
    assert split.partition(2, 5) == [(0, 1), (1, 1)]
