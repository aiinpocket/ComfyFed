import json

import pytest

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


def test_extract_treats_loadaudio_audio_input_as_an_asset():
    # Mirrored client-side in web/src/lib/workflow.ts.
    workflow = {
        "1": {"class_type": "LoadAudio", "inputs": {"audio": "voice.wav"}},
        "2": {"class_type": "LoadImage", "inputs": {"image": "ref.png"}},
    }
    needs = assess.extract(workflow)
    assert needs.assets == {"voice.wav", "ref.png"}


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


def test_eligible_after_fetch_matches_a_peer_by_category_relative_name():
    """A peer's models-root-relative inventory must satisfy a missing model."""
    have_nothing = _worker("w1", node_classes=["KSampler"], dynamic={"free_disk_gb": 500})
    peer = _worker("w2", model_inventory=FLUX_INVENTORY)
    needs = assess.JobNeeds(
        nodes={"KSampler"}, models={"flux1-dev.safetensors"}, est_vram_gb=None, assets=set()
    )

    v = assess.verdict(have_nothing, needs, {}, [have_nothing, peer])
    assert v.kind == "eligible_after_fetch"
    assert v.missing_models == ["flux1-dev.safetensors"]


def test_eligible_after_fetch_uses_the_matched_size_for_the_disk_check():
    """The 11.9 GB size must be found, so 5 GB of free disk is not enough."""
    cramped = _worker("w1", node_classes=["KSampler"], dynamic={"free_disk_gb": 5})
    peer = _worker("w2", model_inventory=FLUX_INVENTORY)
    needs = assess.JobNeeds(
        nodes={"KSampler"}, models={"flux1-dev.safetensors"}, est_vram_gb=None, assets=set()
    )

    v = assess.verdict(cramped, needs, {}, [cramped, peer])
    assert v.kind == "ineligible"
    assert any(r.startswith("missing_models_unavailable") for r in v.reasons)


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
    estimate deliberately takes the largest single model.
    """
    peer = _worker(
        "peer",
        model_inventory=[
            {"name": "diffusion_models/big.safetensors", "size": 11.0},
            {"name": "text_encoders/also_big.safetensors", "size": 9.0},
        ],
    )
    needs = assess.JobNeeds(
        nodes=set(),
        models={"big.safetensors", "also_big.safetensors"},
        est_vram_gb=None,
        assets=set(),
    )

    # 15 GB free clears the largest model (11) but not the total (20).
    cramped = _worker("w1", dynamic={"free_disk_gb": 15.0})
    assert assess.verdict(cramped, needs, {}, [cramped, peer]).kind == "ineligible"

    # 25 GB clears the sum.
    roomy = _worker("w2", dynamic={"free_disk_gb": 25.0})
    assert assess.verdict(roomy, needs, {}, [roomy, peer]).kind == "eligible_after_fetch"
