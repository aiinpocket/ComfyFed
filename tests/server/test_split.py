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


def test_split_plan_accepts_an_integral_float_batch_size():
    workflow = _batch_workflow()
    workflow["4"]["inputs"]["batch_size"] = 4.0
    assert split.split_plan(workflow) == split.SplitPlan(source_node_id="4", batch_size=4)


def test_split_plan_vetoes_a_sampler_wired_to_a_non_zero_slot_of_the_batch_source():
    workflow = _batch_workflow()
    workflow["5"]["inputs"]["latent_image"] = ["4", 1]
    assert split.split_plan(workflow) is None


def test_split_plan_vetoes_a_side_branch_that_reaches_an_output_node_without_the_batch_source_as_ancestor():
    workflow = _batch_workflow()
    workflow["8"] = {"class_type": "LoadImage", "inputs": {"image": "x.png"}}
    workflow["9"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["8", 0], "vae": ["1", 2]}}
    workflow["10"] = {"class_type": "VAEDecode", "inputs": {"samples": ["9", 0], "vae": ["1", 2]}}
    workflow["11"] = {"class_type": "SaveImage", "inputs": {"images": ["10", 0]}}
    assert split.split_plan(workflow) is None


def test_split_plan_still_accepts_the_standard_graph_without_a_side_branch():
    assert split.split_plan(_batch_workflow()) == split.SplitPlan(source_node_id="4", batch_size=4)


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


# --- §3.4 父 job 狀態推導 / §3.5 拆分落地 --------------------------------

import json  # noqa: E402
from datetime import datetime, timedelta, timezone  # noqa: E402

from comfyfed_server import db, metrics  # noqa: E402


@pytest.fixture()
def _db(tmp_path):
    db.init_db(str(tmp_path / "t.db"))
    metrics.init()


def _utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _make_parent(job_id="parent", batch_size=4, k=0):
    workflow = _batch_workflow(batch_size=batch_size)
    with db.get_session() as session:
        session.add(
            db.Job(
                id=job_id,
                workflow_json=json.dumps(workflow),
                status="queued",
                signature="sig",
                required_models=json.dumps([]),
                required_nodes=json.dumps(sorted({n["class_type"] for n in workflow.values()})),
                split_plan=json.dumps({"source_node_id": "4", "batch_size": batch_size}),
                split_count=k,
            )
        )
        session.commit()
    return job_id


def _set_child(child_id, **fields):
    with db.get_session() as session:
        child = session.get(db.Job, child_id)
        for key, value in fields.items():
            setattr(child, key, value)
        session.commit()


def test_create_children_inserts_k_children_and_marks_the_parent(_db):
    parent_id = _make_parent(batch_size=4)

    assert split.create_children(parent_id, 2) == 2

    children = split.children_of(parent_id)
    assert [c.split_index for c in children] == [0, 1]
    assert [c.split_count for c in children] == [0, 0]
    with db.get_session() as session:
        parent = session.get(db.Job, parent_id)
        assert parent.split_count == 2
        assert parent.status == "queued"
    # 子 job 的 workflow 帶了 LatentFromBatch，範圍連續且承襲父的 created_at。
    first = json.loads(children[0].workflow_json)
    second = json.loads(children[1].workflow_json)
    assert first["cfsplit"]["inputs"] == {"samples": ["4", 0], "batch_index": 0, "length": 2}
    assert second["cfsplit"]["inputs"] == {"samples": ["4", 0], "batch_index": 2, "length": 2}
    with db.get_session() as session:
        parent = session.get(db.Job, parent_id)
    assert all(c.created_at == parent.created_at for c in children)
    assert all(c.signature == parent.signature for c in children)
    assert all("LatentFromBatch" in json.loads(c.required_nodes) for c in children)
    assert all(c.parent_id == parent_id for c in children)


def test_create_children_is_a_no_op_without_a_split_plan(_db):
    with db.get_session() as session:
        session.add(db.Job(id="plain", workflow_json="{}", status="queued"))
        session.commit()
    assert split.create_children("plain", 2) == 0


def test_create_children_refuses_a_parent_that_is_already_split(_db):
    """原子護欄：已經拆過（`split_count != 0`）的父 job 不會被拆第二次。"""
    parent_id = _make_parent()
    assert split.create_children(parent_id, 2) == 2
    assert split.create_children(parent_id, 2) == 0
    assert len(split.children_of(parent_id)) == 2


@pytest.mark.parametrize(
    "child_statuses,expected",
    [
        (["queued", "queued"], "queued"),
        (["assigned", "queued"], "assigned"),
        (["running", "queued"], "running"),
        (["running", "assigned"], "running"),
        (["done", "done"], "done"),
        (["done", "running"], "running"),
    ],
)
def test_refresh_parent_derives_the_status_table(_db, child_statuses, expected):
    parent_id = _make_parent()
    split.create_children(parent_id, len(child_statuses))
    for child, status in zip(split.children_of(parent_id), child_statuses):
        _set_child(child.id, status=status)

    changed, status = split.refresh_parent(parent_id)

    assert status == expected
    with db.get_session() as session:
        assert session.get(db.Job, parent_id).status == expected


def test_refresh_parent_assigned_never_gives_the_parent_a_worker(_db):
    parent_id = _make_parent()
    split.create_children(parent_id, 2)
    children = split.children_of(parent_id)
    _set_child(children[0].id, status="assigned", worker_id="w1")

    split.refresh_parent(parent_id)

    with db.get_session() as session:
        parent = session.get(db.Job, parent_id)
    assert (parent.status, parent.worker_id) == ("assigned", None)


def test_refresh_parent_running_takes_the_earliest_start_and_average_progress(_db):
    parent_id = _make_parent()
    split.create_children(parent_id, 2)
    children = split.children_of(parent_id)
    base = _utcnow()
    _set_child(children[0].id, status="running", started_at=base, progress=0.4)
    _set_child(children[1].id, status="running", started_at=base + timedelta(seconds=30), progress=0.8)

    split.refresh_parent(parent_id)

    with db.get_session() as session:
        parent = session.get(db.Job, parent_id)
    assert parent.status == "running"
    assert parent.started_at == base
    assert parent.progress == pytest.approx(0.6)


def test_refresh_parent_done_takes_the_latest_finish(_db):
    parent_id = _make_parent()
    split.create_children(parent_id, 2)
    children = split.children_of(parent_id)
    base = _utcnow()
    _set_child(children[0].id, status="done", finished_at=base, result_files=json.dumps(["a.png"]))
    _set_child(
        children[1].id,
        status="done",
        finished_at=base + timedelta(seconds=5),
        result_files=json.dumps(["b.png"]),
    )

    split.refresh_parent(parent_id)

    with db.get_session() as session:
        parent = session.get(db.Job, parent_id)
    assert parent.status == "done"
    assert parent.finished_at == base + timedelta(seconds=5)
    assert parent.progress == pytest.approx(1.0)
    # 父 job 自己的 result_files 保持空的；輸出由 parent_outputs 組出來。
    assert json.loads(parent.result_files) == []


def test_refresh_parent_failure_cancels_the_surviving_siblings(_db):
    parent_id = _make_parent()
    split.create_children(parent_id, 3)
    children = split.children_of(parent_id)
    _set_child(children[1].id, status="failed", error="CUDA OOM")

    split.refresh_parent(parent_id)

    with db.get_session() as session:
        parent = session.get(db.Job, parent_id)
        statuses = {c.id: session.get(db.Job, c.id).status for c in children}
    assert parent.status == "failed"
    assert parent.error == "子任務 2/3：CUDA OOM"
    assert statuses[children[0].id] == "cancelled"
    assert statuses[children[2].id] == "cancelled"


def test_refresh_parent_cascade_releases_ownership_like_cancel_job(_db):
    """裁決：串聯取消寫的欄位要和 `dispatch.cancel_job` 一模一樣，並把還活著
    的 owner 交回給呼叫端去推 `job_cancelled`。"""
    parent_id = _make_parent()
    split.create_children(parent_id, 2)
    children = split.children_of(parent_id)
    _set_child(children[0].id, status="failed", error="boom")
    _set_child(children[1].id, status="running", worker_id="w9")

    owners: list = []
    split.refresh_parent(parent_id, cancelled_owners=owners)

    assert owners == [(children[1].id, "w9")]
    with db.get_session() as session:
        sibling = session.get(db.Job, children[1].id)
    assert sibling.status == "cancelled"
    assert sibling.worker_id is None
    assert sibling.last_worker_id == "w9"
    assert sibling.error == "sibling failed"
    assert sibling.finished_at is not None


def test_refresh_parent_cancellation_cancels_the_others(_db):
    parent_id = _make_parent()
    split.create_children(parent_id, 2)
    children = split.children_of(parent_id)
    _set_child(children[0].id, status="cancelled", error="cancelled by admin")

    split.refresh_parent(parent_id)

    with db.get_session() as session:
        assert session.get(db.Job, parent_id).status == "cancelled"
        assert session.get(db.Job, parent_id).error == "cancelled by admin"
        assert session.get(db.Job, children[1].id).status == "cancelled"


def test_refresh_parent_ignores_a_job_whose_split_count_is_zero(_db):
    """重試過的父 job（split_count 重設為 0）一律當普通 job 處理。"""
    parent_id = _make_parent(k=0)
    split.create_children(parent_id, 2)
    with db.get_session() as session:
        session.get(db.Job, parent_id).split_count = 0
        session.get(db.Job, parent_id).status = "queued"
        session.commit()

    changed, status = split.refresh_parent(parent_id)
    assert (changed, status) == (False, None)


def test_parent_outputs_are_ordered_by_split_index_then_file_order(_db):
    parent_id = _make_parent()
    split.create_children(parent_id, 2)
    children = split.children_of(parent_id)
    _set_child(children[1].id, status="done", result_files=json.dumps(["c.png", "d.png"]))
    _set_child(children[0].id, status="done", result_files=json.dumps(["a.png", "b.png"]))

    with db.get_session() as session:
        parent = session.get(db.Job, parent_id)
    outputs = split.parent_outputs(parent)

    assert outputs == [
        (children[0].id, "a.png"),
        (children[0].id, "b.png"),
        (children[1].id, "c.png"),
        (children[1].id, "d.png"),
    ]


def test_parent_outputs_is_empty_for_a_plain_job(_db):
    with db.get_session() as session:
        session.add(db.Job(id="plain", workflow_json="{}", status="done"))
        session.commit()
        assert split.parent_outputs(session.get(db.Job, "plain")) == []


def test_child_status_changed_returns_none_for_a_plain_job(_db):
    with db.get_session() as session:
        session.add(db.Job(id="plain", workflow_json="{}", status="queued"))
        session.commit()
    assert split.child_status_changed("plain") is None


def test_child_status_changed_propagates_a_child_transition(_db):
    parent_id = _make_parent()
    split.create_children(parent_id, 2)
    children = split.children_of(parent_id)
    _set_child(children[0].id, status="running")

    assert split.child_status_changed(children[0].id) == "running"
    with db.get_session() as session:
        assert session.get(db.Job, parent_id).status == "running"


def test_plan_for_job_round_trips_a_splittable_workflow(_db):
    assert split.plan_for_job(_batch_workflow(4), {}) == json.dumps(
        {"source_node_id": "4", "batch_size": 4}
    )
    assert split.plan_for_job(_batch_workflow(4), {"split": False}) is None


def test_split_batches_setting_off_disables_planning(_db):
    with db.get_session() as session:
        session.add(db.Setting(key=split.SPLIT_BATCHES_SETTING_KEY, value="0"))
        session.commit()
    assert split.split_batches_enabled() is False
    assert split.plan_for_job(_batch_workflow(4), {}) is None
