import json

import pytest

from comfyfed_server import assess, db, model_guide


def _worker(
    id_,
    node_classes=None,
    model_inventory=None,
    hardware=None,
    dynamic=None,
    protocol=None,
    auto_fetch=None,
):
    return db.Worker(
        id=id_,
        name=id_,
        pubkey="pk",
        node_classes=json.dumps(node_classes if node_classes is not None else []),
        model_inventory=json.dumps(model_inventory if model_inventory is not None else []),
        hardware=json.dumps(hardware if hardware is not None else {}),
        dynamic=json.dumps(dynamic if dynamic is not None else {}),
        protocol=protocol,
        auto_fetch=auto_fetch,
    )


def _fetch_ready_worker(id_, **kwargs):
    """A worker opted into manifest-based auto-fetch: protocol 3 + auto_fetch."""
    kwargs.setdefault("protocol", 3)
    kwargs.setdefault("auto_fetch", True)
    return _worker(id_, **kwargs)


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


def test_model_nodes_maps_each_model_to_its_referencing_nodes():
    mapping = assess.model_nodes(REALISTIC_WORKFLOW)
    assert mapping == {
        "sd_xl_base.safetensors": [("1", "CheckpointLoaderSimple")],
        "my_style.safetensors": [("2", "LoraLoader")],
    }


ONE_MODEL_TWO_NODES = {
    "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "shared.safetensors"}},
    "2": {"class_type": "UNETLoader", "inputs": {"unet_name": "shared.safetensors"}},
}


def test_model_nodes_lists_every_node_referencing_the_same_model():
    mapping = assess.model_nodes(ONE_MODEL_TWO_NODES)
    assert mapping == {
        "shared.safetensors": [
            ("1", "CheckpointLoaderSimple"),
            ("2", "UNETLoader"),
        ]
    }


TWO_MODELS_ONE_NODE = {
    "1": {
        "class_type": "DualCLIPLoader",
        "inputs": {"clip_name1": "clip_l.safetensors", "clip_name2": "t5xxl_fp16.safetensors"},
    },
}


def test_model_nodes_lists_every_model_referenced_by_the_same_node():
    mapping = assess.model_nodes(TWO_MODELS_ONE_NODE)
    assert mapping == {
        "clip_l.safetensors": [("1", "DualCLIPLoader")],
        "t5xxl_fp16.safetensors": [("1", "DualCLIPLoader")],
    }


def test_model_nodes_empty_for_empty_workflow():
    assert assess.model_nodes({}) == {}
    assert assess.model_nodes(None) == {}


def test_estimate_vram_none_when_no_known_size():
    assert assess.estimate_vram({"sd_xl_base.safetensors"}, []) is None


def test_estimate_vram_uses_the_largest_single_model_with_fudge_factor():
    """Peak VRAM is driven by the biggest model, not the sum of all of them.

    ComfyUI loads and offloads models around the diffusion pass, so they are
    not all resident at once. Each model's size is still the largest value
    known for it anywhere in the federation (6.0 here, not w1's stale 4.0).
    """
    w1 = _worker("w1", model_inventory=[{"name": "a.safetensors", "size": 4.0}])
    w2 = _worker("w2", model_inventory=[{"name": "a.safetensors", "size": 6.0}, {"name": "b.safetensors", "size": 2.0}])
    result = assess.estimate_vram({"a.safetensors", "b.safetensors"}, [w1, w2])
    assert result == 6.0 * 1.15


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


def test_verdict_eligible_after_fetch_when_manifest_can_supply_missing_model():
    worker = _fetch_ready_worker(
        "w1",
        node_classes=["CheckpointLoaderSimple"],
        model_inventory=[],
        hardware={"vram_gb": 24},
        dynamic={"free_disk_gb": 100},
    )
    needs = assess.JobNeeds(
        nodes={"CheckpointLoaderSimple"},
        models={"ckpt.safetensors"},
        est_vram_gb=None,
        assets=set(),
    )
    # 4 GiB manifest entry; 100 GB free clears 1.2x margin easily.
    fetchable = {"ckpt.safetensors": 4 * 1024**3}
    v = assess.verdict(worker, needs, {}, [worker], fetchable_models=fetchable)
    assert v.kind == "eligible_after_fetch"
    assert v.missing_models == ["ckpt.safetensors"]
    assert any(r.startswith("missing_models:") for r in v.reasons)


def test_verdict_ineligible_when_fetchable_models_not_supplied():
    """The optional parameter defaults to None -- "nothing fetchable" -- so a
    worker missing a model with no manifest wired in stays ineligible, not
    eligible_after_fetch. This is the Task-4 no-op default."""
    worker = _fetch_ready_worker(
        "w1",
        node_classes=["CheckpointLoaderSimple"],
        model_inventory=[],
        hardware={"vram_gb": 24},
        dynamic={"free_disk_gb": 100},
    )
    needs = assess.JobNeeds(
        nodes={"CheckpointLoaderSimple"},
        models={"ckpt.safetensors"},
        est_vram_gb=None,
        assets=set(),
    )
    v = assess.verdict(worker, needs, {}, [worker])
    assert v.kind == "ineligible"
    assert any(r.startswith("missing_models_unavailable:") for r in v.reasons)


def test_verdict_ineligible_when_only_some_missing_models_are_in_manifest():
    worker = _fetch_ready_worker(
        "w1",
        model_inventory=[],
        dynamic={"free_disk_gb": 100},
    )
    needs = assess.JobNeeds(
        nodes=set(), models={"ckpt.safetensors", "lora.safetensors"}, est_vram_gb=None
    )
    fetchable = {"ckpt.safetensors": 1 * 1024**3}  # lora.safetensors missing from manifest
    v = assess.verdict(worker, needs, {}, [worker], fetchable_models=fetchable)
    assert v.kind == "ineligible"
    assert any(r.startswith("missing_models_unavailable:") for r in v.reasons)


def test_verdict_ineligible_when_protocol_below_3():
    worker = _worker(
        "w1",
        model_inventory=[],
        dynamic={"free_disk_gb": 100},
        protocol=2,
        auto_fetch=True,
    )
    needs = assess.JobNeeds(nodes=set(), models={"ckpt.safetensors"}, est_vram_gb=None)
    fetchable = {"ckpt.safetensors": 1 * 1024**3}
    v = assess.verdict(worker, needs, {}, [worker], fetchable_models=fetchable)
    assert v.kind == "ineligible"
    assert any(r.startswith("missing_models_unavailable:") for r in v.reasons)


def test_verdict_ineligible_when_worker_has_not_opted_into_auto_fetch():
    worker = _worker(
        "w1",
        model_inventory=[],
        dynamic={"free_disk_gb": 100},
        protocol=3,
        auto_fetch=False,
    )
    needs = assess.JobNeeds(nodes=set(), models={"ckpt.safetensors"}, est_vram_gb=None)
    fetchable = {"ckpt.safetensors": 1 * 1024**3}
    v = assess.verdict(worker, needs, {}, [worker], fetchable_models=fetchable)
    assert v.kind == "ineligible"
    assert any(r.startswith("missing_models_unavailable:") for r in v.reasons)


def test_verdict_ineligible_when_disk_margin_insufficient():
    """1.2x margin on a 10 GiB manifest entry needs > 12 GB free; 12 GB flat
    is not enough (strictly greater), 5 GB is nowhere close."""
    worker = _fetch_ready_worker(
        "w1", model_inventory=[], dynamic={"free_disk_gb": 12.0}
    )
    needs = assess.JobNeeds(nodes=set(), models={"big.safetensors"}, est_vram_gb=None)
    fetchable = {"big.safetensors": 10 * 1024**3}
    v = assess.verdict(worker, needs, {}, [worker], fetchable_models=fetchable)
    assert v.kind == "ineligible"
    assert any(r.startswith("missing_models_unavailable:") for r in v.reasons)


def test_verdict_eligible_after_fetch_when_disk_margin_just_clears():
    worker = _fetch_ready_worker(
        "w1", model_inventory=[], dynamic={"free_disk_gb": 12.1}
    )
    needs = assess.JobNeeds(nodes=set(), models={"big.safetensors"}, est_vram_gb=None)
    fetchable = {"big.safetensors": 10 * 1024**3}
    v = assess.verdict(worker, needs, {}, [worker], fetchable_models=fetchable)
    assert v.kind == "eligible_after_fetch"


def test_verdict_ineligible_when_free_disk_unknown():
    """Can't prove the >1.2x margin holds without a free_disk_gb figure at
    all -- unlike the VRAM-offload gate, this one refuses rather than warns:
    an unproven auto-download is a bigger risk than an unproven offload."""
    worker = _fetch_ready_worker("w1", model_inventory=[], dynamic={})
    needs = assess.JobNeeds(nodes=set(), models={"ckpt.safetensors"}, est_vram_gb=None)
    fetchable = {"ckpt.safetensors": 1 * 1024**3}
    v = assess.verdict(worker, needs, {}, [worker], fetchable_models=fetchable)
    assert v.kind == "ineligible"
    assert any(r.startswith("missing_models_unavailable:") for r in v.reasons)


def test_verdict_ineligible_when_manifest_size_sum_exceeds_margin():
    """Disk headroom is a SUM across every model to fetch, not a max."""
    worker = _fetch_ready_worker(
        "w1", model_inventory=[], dynamic={"free_disk_gb": 15.0}
    )
    needs = assess.JobNeeds(
        nodes=set(), models={"big.safetensors", "also_big.safetensors"}, est_vram_gb=None
    )
    fetchable = {
        "big.safetensors": 11 * 1024**3,
        "also_big.safetensors": 9 * 1024**3,
    }
    # Sum is 20 GB; 1.2x margin needs > 24 GB. 15 GB free clears neither.
    v = assess.verdict(worker, needs, {}, [worker], fetchable_models=fetchable)
    assert v.kind == "ineligible"

    roomy = _fetch_ready_worker(
        "w2", model_inventory=[], dynamic={"free_disk_gb": 25.0}
    )
    v2 = assess.verdict(roomy, needs, {}, [roomy], fetchable_models=fetchable)
    assert v2.kind == "eligible_after_fetch"


def test_verdict_eligible_after_fetch_for_zero_holder_curated_model():
    """Phase 3.2: an empty-inventory worker with auto_fetch opted in becomes
    `eligible_after_fetch` for a curated model that NOT A SINGLE fleet worker
    holds, as long as the manifest entry it was handed (built from
    `model_guide.SOURCES`' operator-vouched sha256/size_bytes -- see
    `model_manifest._guide_hash_entry`) is present in `fetchable_models`. This
    is the same `_eligible_after_fetch` gate as always; the only thing Phase
    3.2 changes is that `fetchable_models` can now contain a curated model's
    entry even when zero workers have ever reported it -- confirmed here
    using the REAL curated size_bytes from model_guide.SOURCES rather than an
    arbitrary test fixture size, so this stays honest about what the manifest
    would actually sign."""
    source = model_guide.SOURCES["RealESRGAN_x4plus.pth"]
    assert source.sha256 is not None and source.size_bytes is not None

    worker = _fetch_ready_worker(
        "w1",
        node_classes=["UpscaleModelLoader"],
        model_inventory=[],  # zero holders anywhere, including this worker
        dynamic={"free_disk_gb": 100.0},
    )
    needs = assess.JobNeeds(
        nodes={"UpscaleModelLoader"}, models={"RealESRGAN_x4plus.pth"}, est_vram_gb=None
    )
    fetchable = {"RealESRGAN_x4plus.pth": source.size_bytes}

    v = assess.verdict(worker, needs, {}, [worker], fetchable_models=fetchable)
    assert v.kind == "eligible_after_fetch"
    assert v.missing_models == ["RealESRGAN_x4plus.pth"]


# --- Phase 3.1 P2P: peer-only fetch source requires protocol>=4 -----------


def test_verdict_peer_only_model_ineligible_at_protocol_3():
    """A protocol-3 worker can auto-fetch a URL-sourced model just fine, but
    has no way to speak the peer-grant/chunk-pull protocol -- a missing model
    whose ONLY manifest source is a peer (`peer_only_models`) must exclude it
    from `eligible_after_fetch` even though every other gate (auto_fetch,
    disk) passes."""
    worker = _fetch_ready_worker(
        "w1", model_inventory=[], dynamic={"free_disk_gb": 100}
    )  # protocol=3 via _fetch_ready_worker
    needs = assess.JobNeeds(nodes=set(), models={"peer.safetensors"}, est_vram_gb=None)
    fetchable = {"peer.safetensors": 1 * 1024**3}
    v = assess.verdict(
        worker, needs, {}, [worker], fetchable_models=fetchable,
        peer_only_models=frozenset({"peer.safetensors"}),
    )
    assert v.kind == "ineligible"
    # L6 final-review fix: distinguishable from the generic "nowhere in the
    # federation" reason -- this worker's protocol is specifically the
    # blocker, not a genuinely unfetchable model.
    assert any(r.startswith("missing_models_peer_protocol:") for r in v.reasons)
    assert not any(r.startswith("missing_models_unavailable:") for r in v.reasons)


def test_verdict_peer_only_model_eligible_after_fetch_at_protocol_4():
    worker = _fetch_ready_worker(
        "w1", model_inventory=[], dynamic={"free_disk_gb": 100}, protocol=4
    )
    needs = assess.JobNeeds(nodes=set(), models={"peer.safetensors"}, est_vram_gb=None)
    fetchable = {"peer.safetensors": 1 * 1024**3}
    v = assess.verdict(
        worker, needs, {}, [worker], fetchable_models=fetchable,
        peer_only_models=frozenset({"peer.safetensors"}),
    )
    assert v.kind == "eligible_after_fetch"
    assert v.missing_models == ["peer.safetensors"]


def test_verdict_url_only_missing_model_unaffected_by_peer_only_models_param():
    """`peer_only_models` only raises the bar for names actually IN that set
    -- a protocol-3 worker stays eligible_after_fetch for a plain URL-sourced
    missing model even when the parameter is non-empty (for some OTHER
    name)."""
    worker = _fetch_ready_worker(
        "w1", model_inventory=[], dynamic={"free_disk_gb": 100}
    )
    needs = assess.JobNeeds(nodes=set(), models={"url_only.safetensors"}, est_vram_gb=None)
    fetchable = {"url_only.safetensors": 1 * 1024**3}
    v = assess.verdict(
        worker, needs, {}, [worker], fetchable_models=fetchable,
        peer_only_models=frozenset({"some_other_peer_only.safetensors"}),
    )
    assert v.kind == "eligible_after_fetch"


def test_verdict_mixed_missing_models_peer_only_gate_applies_to_whole_job():
    """One missing model is URL-fetchable, the other peer-only -- since
    `eligible_after_fetch` is an all-or-nothing verdict for the whole job (a
    worker either fetches everything it's missing or it isn't eligible yet),
    a protocol-3 worker is ineligible for the WHOLE job, not just the
    peer-only half."""
    worker = _fetch_ready_worker(
        "w1", model_inventory=[], dynamic={"free_disk_gb": 100}
    )
    needs = assess.JobNeeds(
        nodes=set(), models={"url_only.safetensors", "peer.safetensors"}, est_vram_gb=None
    )
    fetchable = {
        "url_only.safetensors": 1 * 1024**3,
        "peer.safetensors": 1 * 1024**3,
    }
    v = assess.verdict(
        worker, needs, {}, [worker], fetchable_models=fetchable,
        peer_only_models=frozenset({"peer.safetensors"}),
    )
    assert v.kind == "ineligible"


# --- partition_fleet_fetchable: peer-only requires an online protocol>=4 --
# --- worker among the candidates, same rule as verdict's per-candidate gate


def test_partition_fleet_fetchable_peer_only_model_unfetchable_without_protocol_4_worker():
    online = [
        _fetch_ready_worker("w1", model_inventory=[], dynamic={"free_disk_gb": 100})
    ]  # protocol 3
    fetchable = {"peer.safetensors": 1 * 1024**3}
    fetchable_set, unfetchable = assess.partition_fleet_fetchable(
        {"peer.safetensors"}, fetchable, online, peer_only_models=frozenset({"peer.safetensors"})
    )
    assert fetchable_set == set()
    assert unfetchable == {"peer.safetensors"}


def test_partition_fleet_fetchable_peer_only_model_fetchable_with_a_protocol_4_worker():
    online = [
        _fetch_ready_worker("w1", model_inventory=[], dynamic={"free_disk_gb": 100}, protocol=4)
    ]
    fetchable = {"peer.safetensors": 1 * 1024**3}
    fetchable_set, unfetchable = assess.partition_fleet_fetchable(
        {"peer.safetensors"}, fetchable, online, peer_only_models=frozenset({"peer.safetensors"})
    )
    assert fetchable_set == {"peer.safetensors"}
    assert unfetchable == set()


def test_partition_fleet_fetchable_peer_only_models_none_matches_pre_task_6_behavior():
    """Omitting `peer_only_models` (None, the default) reproduces the exact
    pre-Task-6 behavior -- a protocol-3 worker is enough for any manifest-
    covered model, since nothing is considered peer-only."""
    online = [
        _fetch_ready_worker("w1", model_inventory=[], dynamic={"free_disk_gb": 100})
    ]
    fetchable = {"whatever.safetensors": 1 * 1024**3}
    fetchable_set, unfetchable = assess.partition_fleet_fetchable(
        {"whatever.safetensors"}, fetchable, online
    )
    assert fetchable_set == {"whatever.safetensors"}
    assert unfetchable == set()


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


def test_extract_treats_loadaudio_audio_input_as_an_asset():
    # Mirrored client-side in web/src/lib/workflow.ts.
    workflow = {
        "1": {"class_type": "LoadAudio", "inputs": {"audio": "voice.wav"}},
        "2": {"class_type": "LoadImage", "inputs": {"image": "ref.png"}},
    }
    needs = assess.extract(workflow)
    assert needs.assets == {"voice.wav", "ref.png"}


def test_extract_treats_loadvideo_file_input_as_an_asset():
    # Core LoadVideo names its asset field `file` (video_upload combo).
    # Mirrored client-side in web/src/lib/workflow.ts.
    workflow = {
        "1": {"class_type": "LoadVideo", "inputs": {"file": "clip.mp4"}},
        "2": {"class_type": "GetVideoComponents", "inputs": {"video": ["1", 0]}},
    }
    needs = assess.extract(workflow)
    assert needs.assets == {"clip.mp4"}


def test_verdict_backend_override_mismatch_is_ineligible():
    worker = _worker("w1")
    worker.backend = "rocm"
    needs = assess.JobNeeds(nodes=set(), models=set(), est_vram_gb=None, assets=set())

    v = assess.verdict(worker, needs, {"backend": "cuda"}, [worker])
    assert v.kind == "ineligible"
    assert "backend:cuda!=rocm" in v.reasons


def test_verdict_backend_override_match_is_eligible():
    worker = _worker("w1")
    worker.backend = "cuda"
    needs = assess.JobNeeds(nodes=set(), models=set(), est_vram_gb=None, assets=set())

    assert assess.verdict(worker, needs, {"backend": "cuda"}, [worker]).kind == "eligible"


def test_verdict_without_backend_override_ignores_worker_backend():
    """Phase 1 derives nothing: with no override, backend never gates dispatch."""
    worker = _worker("w1")
    worker.backend = "cpu"
    needs = assess.JobNeeds(nodes=set(), models=set(), est_vram_gb=None, assets=set())

    assert assess.verdict(worker, needs, {}, [worker]).kind == "eligible"


def test_needs_from_job_reparses_persisted_requirements():
    job = db.Job(
        workflow_json="{}",
        required_nodes=json.dumps(["KSampler"]),
        required_models=json.dumps(["ckpt.safetensors"]),
        est_vram_gb=7.5,
    )
    needs = assess.needs_from_job(job)
    assert needs.nodes == {"KSampler"}
    assert needs.models == {"ckpt.safetensors"}
    assert needs.est_vram_gb == 7.5
    assert needs.assets == set()


def test_needs_from_job_survives_corrupt_json_columns():
    job = db.Job(workflow_json="{}", required_nodes="not json", required_models=None, est_vram_gb=None)
    needs = assess.needs_from_job(job)
    assert needs.nodes == set()
    assert needs.models == set()


# --------------------------------------------------------------------------
# Model-name matching across the inventory/loader root mismatch.
#
# Live-reproduced bug: a worker's inventory is relative to the models ROOT
# ("diffusion_models/flux1-dev.safetensors") while a workflow's loader value
# is relative to its CATEGORY folder ("flux1-dev.safetensors"). Exact string
# comparison judged every model on every real machine missing, so nothing was
# ever dispatched.
# --------------------------------------------------------------------------


def test_matches_model_name_strips_the_category_directory():
    assert assess.matches_model_name("diffusion_models/flux1-dev.safetensors", "flux1-dev.safetensors")
    assert assess.matches_model_name("vae/ae.safetensors", "ae.safetensors")
    assert assess.matches_model_name("text_encoders/t5xxl_fp16.safetensors", "t5xxl_fp16.safetensors")


def test_matches_model_name_keeps_deeper_subfolders():
    # A loras loader value carries its subfolder; only the category is stripped.
    assert assess.matches_model_name("loras/wuxia/x.safetensors", "wuxia/x.safetensors")
    assert assess.matches_model_name("loras/wuxia/x.safetensors", "x.safetensors")  # lenient fallback


def test_matches_model_name_handles_windows_separators():
    assert assess.matches_model_name(r"diffusion_models\flux1-dev.safetensors", "flux1-dev.safetensors")
    assert assess.matches_model_name(r"loras\wuxia\x.safetensors", "wuxia/x.safetensors")


def test_matches_model_name_still_matches_identical_names():
    assert assess.matches_model_name("flux1-dev.safetensors", "flux1-dev.safetensors")


def test_matches_model_name_rejects_unrelated_and_partial_names():
    assert not assess.matches_model_name("diffusion_models/flux1-dev.safetensors", "sd_xl_base.safetensors")
    # Must not match on a bare suffix that isn't a whole path component.
    assert not assess.matches_model_name("diffusion_models/xflux1-dev.safetensors", "flux1-dev.safetensors")
    # One-directional: the needed name never carries the extra components.
    assert not assess.matches_model_name("flux1-dev.safetensors", "diffusion_models/flux1-dev.safetensors")
    assert not assess.matches_model_name("", "flux1-dev.safetensors")


FLUX_INVENTORY = [
    {"name": "diffusion_models/flux1-dev.safetensors", "size": 11.9},
    {"name": "vae/ae.safetensors", "size": 0.3},
    {"name": "text_encoders/t5xxl_fp16.safetensors", "size": 9.8},
    {"name": "text_encoders/clip_l.safetensors", "size": 0.25},
]

# Loader values as ComfyUI actually writes them: category-relative.
FLUX_NEEDED = {
    "flux1-dev.safetensors",
    "ae.safetensors",
    "t5xxl_fp16.safetensors",
    "clip_l.safetensors",
}


def test_real_world_flux_inventory_is_eligible():
    """The live repro: rtx5080-main + a flux workflow must be eligible."""
    worker = _worker(
        "rtx5080-main",
        node_classes=["UNETLoader", "DualCLIPLoader", "VAELoader", "KSampler"],
        model_inventory=FLUX_INVENTORY,
        hardware={"vram_gb": 16},
    )
    needs = assess.JobNeeds(
        nodes={"UNETLoader", "DualCLIPLoader", "VAELoader", "KSampler"},
        models=set(FLUX_NEEDED),
        est_vram_gb=None,
        assets=set(),
    )

    v = assess.verdict(worker, needs, {}, [worker])
    assert v.kind == "eligible"
    assert v.missing_models == []
    assert v.reasons == []


def test_estimate_vram_finds_category_relative_models():
    worker = _worker("w1", model_inventory=FLUX_INVENTORY)

    estimate = assess.estimate_vram({"flux1-dev.safetensors", "ae.safetensors"}, [worker])
    assert estimate is not None
    # The sizes were actually found, and the largest (11.9, not 0.3) drives
    # the estimate -- x the 1.15 fudge factor.
    assert estimate == pytest.approx(11.9 * 1.15)


def test_estimate_vram_returns_none_when_nothing_matches():
    worker = _worker("w1", model_inventory=FLUX_INVENTORY)
    assert assess.estimate_vram({"not_here.safetensors"}, [worker]) is None


def test_eligible_after_fetch_missing_model_check_still_uses_category_relative_matching():
    """The worker's OWN inventory is still checked with `matches_model_name`
    (models-root-relative) before anything is considered missing at all --
    the manifest only supplies what the worker truly lacks."""
    worker = _fetch_ready_worker(
        "w1", node_classes=["KSampler"], model_inventory=FLUX_INVENTORY,
        dynamic={"free_disk_gb": 500},
    )
    needs = assess.JobNeeds(
        nodes={"KSampler"}, models={"flux1-dev.safetensors"}, est_vram_gb=None, assets=set()
    )
    # Already present (category-relative match) -- nothing to fetch.
    v = assess.verdict(worker, needs, {}, [worker], fetchable_models={"flux1-dev.safetensors": 1})
    assert v.kind == "eligible"
    assert v.missing_models == []


def test_find_model_reports_presence_and_the_largest_known_size():
    inventory = [
        {"name": "loras/style.safetensors", "size": 0.1},
        {"name": "checkpoints/style.safetensors", "size": 2.0},  # same basename, bigger
        {"name": "vae/broken.safetensors", "size": "not a number"},
    ]
    assert assess.find_model(inventory, "style.safetensors") == (True, 2.0)
    assert assess.find_model(inventory, "broken.safetensors") == (True, None)
    assert assess.find_model(inventory, "absent.safetensors") == (False, None)
    assert assess.find_model([], "anything") == (False, None)
    assert assess.find_model([{"no_name": 1}, "junk"], "anything") == (False, None)


def test_fetch_disk_headroom_is_still_a_sum_not_a_max():
    """Disk and VRAM measure different resources.

    Every fetched model lands on disk and stays there simultaneously, so the
    eligible_after_fetch headroom check sums them -- even though the VRAM
    estimate deliberately takes the largest single model. (Covered in more
    detail, with the 1.2x margin, by
    test_verdict_ineligible_when_manifest_size_sum_exceeds_margin above.)
    """
    needs = assess.JobNeeds(
        nodes=set(),
        models={"big.safetensors", "also_big.safetensors"},
        est_vram_gb=None,
        assets=set(),
    )
    fetchable = {
        "big.safetensors": 11 * 1024**3,
        "also_big.safetensors": 9 * 1024**3,
    }

    # 24 GB free clears the largest model x1.2 (13.2) but not the margin on
    # the total (20 x 1.2 = 24, and the gate is strictly-greater).
    cramped = _fetch_ready_worker("w1", dynamic={"free_disk_gb": 24.0})
    assert (
        assess.verdict(cramped, needs, {}, [cramped], fetchable_models=fetchable).kind
        == "ineligible"
    )

    # 25 GB clears the margin on the sum.
    roomy = _fetch_ready_worker("w2", dynamic={"free_disk_gb": 25.0})
    assert (
        assess.verdict(roomy, needs, {}, [roomy], fetchable_models=fetchable).kind
        == "eligible_after_fetch"
    )


# --- VRAM: offload-aware gate (LIVE-3) ----------------------------------------
#
# ComfyUI streams and offloads weights to system RAM when they do not fit in
# VRAM: slower, but it runs. Real-machine verification found a 15.9 GB card
# executing a 22.17 GB flux1-dev (est 25.49) and a 33B video model, while the
# old `est > vram` hard gate declared every worker ineligible and left the job
# queued forever. The bar is now VRAM + system RAM; in between, eligible with
# a non-blocking `vram_offload` warning.


def _vram_verdict(*, est, vram=None, ram=None, free_ram=None):
    hardware = {}
    if vram is not None:
        hardware["vram_gb"] = vram
    if ram is not None:
        hardware["ram_gb"] = ram
    dynamic = {}
    if free_ram is not None:
        dynamic["free_ram_gb"] = free_ram

    worker = _worker("w", node_classes=["KSampler"], hardware=hardware, dynamic=dynamic)
    needs = assess.JobNeeds(nodes={"KSampler"}, models=set(), est_vram_gb=est)
    return assess.verdict(worker, needs, {}, [worker])


def test_model_fitting_in_vram_is_eligible_with_no_warning():
    v = _vram_verdict(est=10.0, vram=15.9, ram=63.6)
    assert v.kind == "eligible"
    assert v.reasons == [] and v.warnings == []


def test_model_over_vram_but_within_vram_plus_ram_warns_and_stays_eligible():
    # The exact real-machine numbers: flux1-dev 22.17 GB * 1.15 = 25.4955.
    v = _vram_verdict(est=22.17 * 1.15, vram=15.9, ram=63.6)
    assert v.kind == "eligible"
    assert v.reasons == []
    assert v.warnings == [f"vram_offload:{22.17 * 1.15}>15.9"]


def test_model_over_vram_plus_ram_is_hard_ineligible():
    v = _vram_verdict(est=46.0, vram=8.0, ram=16.0)
    assert v.kind == "ineligible"
    assert v.reasons == ["vram:46.0>8.0+16.0"]
    # A warning explains how an eligible job runs; this one does not run.
    assert v.warnings == []


def test_exactly_at_the_vram_plus_ram_ceiling_is_eligible():
    v = _vram_verdict(est=24.0, vram=8.0, ram=16.0)
    assert v.kind == "eligible"
    assert v.warnings == ["vram_offload:24.0>8.0"]


def test_free_ram_from_the_last_heartbeat_stands_in_for_missing_total_ram():
    """Older agents report no hardware.ram_gb; the heartbeat's free RAM is the
    closest thing available."""
    v = _vram_verdict(est=20.0, vram=8.0, free_ram=32.0)
    assert v.kind == "eligible"
    assert v.warnings == ["vram_offload:20.0>8.0"]

    v = _vram_verdict(est=60.0, vram=8.0, free_ram=32.0)
    assert v.kind == "ineligible"
    assert v.reasons == ["vram:60.0>8.0+32.0"]


def test_unknown_ram_warns_rather_than_refusing():
    """Refusing on a missing datum is exactly what stranded jobs before. With
    no RAM figure at all we cannot prove the weights do not fit."""
    v = _vram_verdict(est=100.0, vram=8.0)
    assert v.kind == "eligible"
    assert v.warnings == ["vram_offload:100.0>8.0"]


def test_unknown_vram_skips_the_check_entirely():
    v = _vram_verdict(est=100.0, ram=64.0)
    assert v.kind == "eligible"
    assert v.reasons == [] and v.warnings == []


def test_min_vram_override_remains_a_hard_refusal():
    worker = _worker(
        "w", node_classes=["KSampler"], hardware={"vram_gb": 15.9, "ram_gb": 63.6}
    )
    needs = assess.JobNeeds(nodes={"KSampler"}, models=set(), est_vram_gb=25.5)
    v = assess.verdict(worker, needs, {"min_vram_gb": 24.0}, [worker])
    assert v.kind == "ineligible"
    assert v.reasons == ["override:min_vram_gb"]


def test_a_warning_survives_an_eligible_after_fetch_verdict():
    """The job still needs a manifest-fetched model AND will offload -- both
    facts are true and the submitter should see each in its own place."""
    worker = _fetch_ready_worker(
        "w",
        node_classes=["KSampler"],
        hardware={"vram_gb": 8.0, "ram_gb": 64.0},
        dynamic={"free_disk_gb": 500.0},
    )
    needs = assess.JobNeeds(
        nodes={"KSampler"}, models={"flux1-dev.safetensors"}, est_vram_gb=25.5
    )
    fetchable = {"flux1-dev.safetensors": int(22.17 * 1024**3)}
    v = assess.verdict(worker, needs, {}, [worker], fetchable_models=fetchable)
    assert v.kind == "eligible_after_fetch"
    assert v.reasons == ["missing_models:flux1-dev.safetensors"]
    assert v.warnings == ["vram_offload:25.5>8.0"]


def test_extract_sees_pth_models():
    """Caught live (Phase 2.1 T8): `.pth` was missing from _MODEL_EXTENSIONS,
    making RealESRGAN_x4plus.pth invisible to extraction -- the upscale
    template's missing-model gate and auto-fetch never fired for it."""
    workflow = {
        "2": {
            "class_type": "UpscaleModelLoader",
            "inputs": {"model_name": "RealESRGAN_x4plus.pth"},
        }
    }
    needs = assess.extract(workflow)
    assert "RealESRGAN_x4plus.pth" in needs.models
