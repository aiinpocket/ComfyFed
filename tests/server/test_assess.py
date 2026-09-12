import json

from comfyfed_server import assess, db


def _worker(id_, node_classes=None, model_inventory=None, hardware=None, dynamic=None):
    return db.Worker(
        id=id_,
        name=id_,
        pubkey="pk",
        node_classes=json.dumps(node_classes if node_classes is not None else []),
        model_inventory=json.dumps(model_inventory if model_inventory is not None else []),
        hardware=json.dumps(hardware if hardware is not None else {}),
        dynamic=json.dumps(dynamic if dynamic is not None else {}),
    )


REALISTIC_WORKFLOW = {
    "1": {
        "class_type": "CheckpointLoaderSimple",
        "inputs": {"ckpt_name": "sd_xl_base.safetensors"},
    },
    "2": {
        "class_type": "LoraLoader",
        "inputs": {"lora_name": "my_style.safetensors", "model": ["1", 0]},
    },
    "3": {
        "class_type": "LoadImage",
        "inputs": {"image": "reference.png"},
    },
    "4": {
        "class_type": "IPAdapter",
        "inputs": {"weight": 0.5},
    },
    "5": {
        "class_type": "KSampler",
        "inputs": {"seed": 42, "model": ["2", 0]},
    },
}


def test_extract_finds_nodes_models_and_assets():
    needs = assess.extract(REALISTIC_WORKFLOW)
    assert needs.nodes == {
        "CheckpointLoaderSimple",
        "LoraLoader",
        "LoadImage",
        "IPAdapter",
        "KSampler",
    }
    assert needs.models == {"sd_xl_base.safetensors", "my_style.safetensors"}
    assert needs.assets == {"reference.png"}
    assert needs.est_vram_gb is None


def test_estimate_vram_none_when_no_known_size():
    assert assess.estimate_vram({"sd_xl_base.safetensors"}, []) is None


def test_estimate_vram_sums_max_known_size_with_fudge_factor():
    w1 = _worker("w1", model_inventory=[{"name": "a.safetensors", "size": 4.0}])
    w2 = _worker("w2", model_inventory=[{"name": "a.safetensors", "size": 6.0}, {"name": "b.safetensors", "size": 2.0}])
    result = assess.estimate_vram({"a.safetensors", "b.safetensors"}, [w1, w2])
    assert result == (6.0 + 2.0) * 1.15


def test_verdict_eligible_when_everything_present():
    worker = _worker(
        "w1",
        node_classes=["CheckpointLoaderSimple", "KSampler"],
        model_inventory=[{"name": "ckpt.safetensors", "size": 4.0}],
        hardware={"vram_gb": 24, "gpu_name": "RTX 4090"},
    )
    needs = assess.JobNeeds(
        nodes={"CheckpointLoaderSimple", "KSampler"},
        models={"ckpt.safetensors"},
        est_vram_gb=4.6,
        assets=set(),
    )
    v = assess.verdict(worker, needs, {}, [worker])
    assert v.kind == "eligible"
    assert v.reasons == []
    assert v.missing_models == []


def test_verdict_eligible_after_fetch_when_other_worker_has_missing_model():
    worker = _worker(
        "w1",
        node_classes=["CheckpointLoaderSimple"],
        model_inventory=[],
        hardware={"vram_gb": 24},
        dynamic={"free_disk_gb": 100},
    )
    other = _worker(
        "w2",
        model_inventory=[{"name": "ckpt.safetensors", "size": 4.0}],
    )
    needs = assess.JobNeeds(
        nodes={"CheckpointLoaderSimple"},
        models={"ckpt.safetensors"},
        est_vram_gb=None,
        assets=set(),
    )
    v = assess.verdict(worker, needs, {}, [worker, other])
    assert v.kind == "eligible_after_fetch"
    assert v.missing_models == ["ckpt.safetensors"]
    assert any(r.startswith("missing_models:") for r in v.reasons)


def test_verdict_ineligible_when_missing_node():
    worker = _worker(
        "w1",
        node_classes=["KSampler"],
        model_inventory=[{"name": "ckpt.safetensors", "size": 4.0}],
        hardware={"vram_gb": 24},
    )
    needs = assess.JobNeeds(
        nodes={"IPAdapter", "KSampler"},
        models={"ckpt.safetensors"},
        est_vram_gb=None,
        assets=set(),
    )
    v = assess.verdict(worker, needs, {}, [worker])
    assert v.kind == "ineligible"
    assert any(r.startswith("missing_nodes:IPAdapter") for r in v.reasons)


def test_verdict_skips_node_check_when_worker_never_connected():
    # Empty node_classes ('[]') means "unknown" for a Phase-1 worker that has
    # never connected, not "supports nothing" -- so the node check is skipped.
    worker = _worker(
        "w1",
        node_classes=[],
        model_inventory=[{"name": "ckpt.safetensors", "size": 4.0}],
        hardware={"vram_gb": 24},
    )
    needs = assess.JobNeeds(
        nodes={"SomeExoticCustomNode"},
        models={"ckpt.safetensors"},
        est_vram_gb=None,
        assets=set(),
    )
    v = assess.verdict(worker, needs, {}, [worker])
    assert v.kind == "eligible"


def test_verdict_ineligible_on_vram_override():
    worker = _worker("w1", hardware={"vram_gb": 8})
    needs = assess.JobNeeds(nodes=set(), models=set(), est_vram_gb=None, assets=set())
    v = assess.verdict(worker, needs, {"min_vram_gb": 16}, [worker])
    assert v.kind == "ineligible"
    assert "override:min_vram_gb" in v.reasons
