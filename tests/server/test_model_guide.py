"""Tests for `model_guide`: the curated + harvested model-source registry and
the zh-TW pre-execution guidance message rendered on POST /prompt rejection."""

import json
import os

from comfyfed_server import model_guide


# --- curated registry --------------------------------------------------


def test_all_eleven_curated_names_resolve(tmp_path):
    data_dir = str(tmp_path)
    assert len(model_guide.SOURCES) == 11
    for name, source in model_guide.SOURCES.items():
        found = model_guide.lookup(name, data_dir)
        assert found is not None
        assert found.official_url == source.official_url
        assert found.directory == source.directory


def test_curated_flux1_dev_fields():
    source = model_guide.SOURCES["flux1-dev.safetensors"]
    assert source.directory == "diffusion_models"
    assert source.size_gb == 22.17
    assert source.official_page == "https://huggingface.co/black-forest-labs/FLUX.1-dev"
    assert (
        source.official_url
        == "https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/flux1-dev.safetensors"
    )
    assert source.backup_url == "https://storage.googleapis.com/comfyfed-models/models/diffusion_models/flux1-dev.safetensors"
    assert source.gated is True


def test_curated_qwen3vl_4b_fields():
    """Phase 1.8b Task 2: entry #10, shared by the two prompt-helper templates."""
    source = model_guide.SOURCES["qwen3vl_4b_bf16.safetensors"]
    assert source.directory == "text_encoders"
    assert source.size_gb == 8.27
    assert source.official_page == "https://huggingface.co/Comfy-Org/Krea-2"
    assert (
        source.official_url
        == "https://huggingface.co/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_bf16.safetensors"
    )
    assert (
        source.backup_url
        == "https://storage.googleapis.com/comfyfed-models/models/text_encoders/qwen3vl_4b_bf16.safetensors"
    )
    assert source.gated is False


def test_curated_realesrgan_fields():
    """Phase 1.10 Task 1: entry #11, shared by the image-upscale template."""
    source = model_guide.SOURCES["RealESRGAN_x4plus.pth"]
    assert source.directory == "upscale_models"
    assert source.size_gb == 0.06
    assert source.official_page == "https://github.com/xinntao/Real-ESRGAN"
    assert (
        source.official_url
        == "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth"
    )
    assert (
        source.backup_url
        == "https://storage.googleapis.com/comfyfed-models/models/upscale_models/RealESRGAN_x4plus.pth"
    )
    assert source.gated is False


def test_curated_lookup_is_bare_name_only_but_matches_category_relative(tmp_path):
    data_dir = str(tmp_path)
    # bare name (as stored in SOURCES)
    assert model_guide.lookup("clip_l.safetensors", data_dir) is not None
    # category-relative -- a workflow loader value that already carries the
    # category folder, same shape assess.matches_model_name resolves.
    found = model_guide.lookup("text_encoders/clip_l.safetensors", data_dir)
    assert found is not None
    assert found.directory == "text_encoders"


def test_lookup_unknown_model_returns_none(tmp_path):
    assert model_guide.lookup("totally_unknown_model.safetensors", str(tmp_path)) is None


# --- harvest -------------------------------------------------------------


def _write_official_template(data_dir, name, models):
    """Seed one official-library workflow JSON in the shape the REAL library
    uses: download metadata on each node's `properties.models`, no top-level
    `models` key (0 of the 550 workflows in `comfyui-workflow-templates-json`
    have one)."""
    official_dir = os.path.join(data_dir, "comfy_templates_official")
    os.makedirs(official_dir, exist_ok=True)
    workflow = {
        "id": name,
        "nodes": [
            {"id": 1, "type": "Note", "properties": {}},
            {
                "id": 2,
                "type": "UNETLoader",
                "properties": {"Node name for S&R": "UNETLoader", "models": models},
            },
        ],
        "links": [],
    }
    with open(os.path.join(official_dir, f"{name}.json"), "w", encoding="utf-8") as f:
        json.dump(workflow, f)


def _write_top_level_models_template(data_dir, name, models):
    """The other accepted shape: a top-level `models` list."""
    official_dir = os.path.join(data_dir, "comfy_templates_official")
    os.makedirs(official_dir, exist_ok=True)
    with open(os.path.join(official_dir, f"{name}.json"), "w", encoding="utf-8") as f:
        json.dump({"nodes": [], "models": models}, f)


def test_harvest_reads_per_node_properties_models(tmp_path):
    data_dir = str(tmp_path)
    _write_official_template(
        data_dir,
        "some_template",
        [
            {
                "name": "harvested_model.safetensors",
                "url": "https://example.com/harvested_model.safetensors",
                "directory": "checkpoints",
            }
        ],
    )

    harvested = model_guide.harvest(data_dir)
    assert harvested["harvested_model.safetensors"] == {
        "url": "https://example.com/harvested_model.safetensors",
        "directory": "checkpoints",
    }


def test_harvest_also_reads_a_top_level_models_list(tmp_path):
    data_dir = str(tmp_path)
    _write_top_level_models_template(
        data_dir,
        "legacy_template",
        [
            {
                "name": "legacy_model.safetensors",
                "url": "https://example.com/legacy_model.safetensors",
                "directory": "loras",
            }
        ],
    )

    assert model_guide.harvest(data_dir)["legacy_model.safetensors"] == {
        "url": "https://example.com/legacy_model.safetensors",
        "directory": "loras",
    }


def test_harvest_reads_subgraph_definitions(tmp_path):
    """Subgraph-based workflows keep their model metadata under
    `definitions.subgraphs[].nodes[].properties.models` (the shape
    `image_z_image_turbo` ships) -- harvest's recursive walk must reach it."""
    data_dir = str(tmp_path)
    official_dir = os.path.join(data_dir, "comfy_templates_official")
    os.makedirs(official_dir, exist_ok=True)
    workflow = {
        "id": "z_image",
        "nodes": [],
        "definitions": {
            "subgraphs": [
                {
                    "id": "sg-1",
                    "nodes": [
                        {
                            "id": 62,
                            "type": "CLIPLoader",
                            "properties": {
                                "models": [
                                    {
                                        "name": "qwen_3_4b.safetensors",
                                        "url": "https://example.com/qwen_3_4b.safetensors",
                                        "directory": "text_encoders",
                                    }
                                ]
                            },
                        }
                    ],
                }
            ]
        },
    }
    with open(os.path.join(official_dir, "z_image.json"), "w", encoding="utf-8") as f:
        json.dump(workflow, f)

    assert model_guide.harvest(data_dir)["qwen_3_4b.safetensors"] == {
        "url": "https://example.com/qwen_3_4b.safetensors",
        "directory": "text_encoders",
    }


def test_harvest_gathers_models_from_several_nodes(tmp_path):
    data_dir = str(tmp_path)
    official_dir = os.path.join(data_dir, "comfy_templates_official")
    os.makedirs(official_dir, exist_ok=True)
    workflow = {
        "nodes": [
            {
                "id": 1,
                "properties": {
                    "models": [{"name": "a.safetensors", "url": "https://e/a", "directory": "vae"}]
                },
            },
            {"id": 2, "properties": {"models": "not-a-list"}},
            {"id": 3, "properties": None},
            {
                "id": 4,
                "properties": {
                    "models": [
                        {"name": "b.safetensors", "url": "https://e/b", "directory": "loras"}
                    ]
                },
            },
        ]
    }
    with open(os.path.join(official_dir, "multi.json"), "w", encoding="utf-8") as f:
        json.dump(workflow, f)

    harvested = model_guide.harvest(data_dir)
    assert sorted(harvested) == ["a.safetensors", "b.safetensors"]


def test_harvest_ignores_index_and_manifest_files(tmp_path):
    data_dir = str(tmp_path)
    official_dir = os.path.join(data_dir, "comfy_templates_official")
    os.makedirs(official_dir, exist_ok=True)
    with open(os.path.join(official_dir, "index.json"), "w", encoding="utf-8") as f:
        json.dump([{"title": "cat"}], f)
    with open(os.path.join(official_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"meta_version": "1.0"}, f)

    harvested = model_guide.harvest(data_dir)
    assert harvested == {}


def test_harvest_empty_when_official_dir_absent(tmp_path):
    assert model_guide.harvest(str(tmp_path)) == {}


def test_lookup_falls_back_to_harvested(tmp_path):
    data_dir = str(tmp_path)
    _write_official_template(
        data_dir,
        "another_template",
        [
            {
                "name": "harvested_only.safetensors",
                "url": "https://example.com/harvested_only.safetensors",
                "directory": "loras",
            }
        ],
    )

    found = model_guide.lookup("harvested_only.safetensors", data_dir)
    assert found is not None
    assert found.official_url == "https://example.com/harvested_only.safetensors"
    assert found.directory == "loras"
    assert found.size_gb is None
    assert found.backup_url is None
    assert found.gated is False


def test_curated_takes_priority_over_harvested(tmp_path):
    data_dir = str(tmp_path)
    _write_official_template(
        data_dir,
        "collides",
        [
            {
                "name": "flux1-dev.safetensors",
                "url": "https://not-the-real-one.example/flux1-dev.safetensors",
                "directory": "somewhere_else",
            }
        ],
    )

    found = model_guide.lookup("flux1-dev.safetensors", data_dir)
    assert found.directory == "diffusion_models"
    assert found.official_url == model_guide.SOURCES["flux1-dev.safetensors"].official_url


# --- guidance_message ------------------------------------------------------


def test_guidance_message_curated_gated_harvested_and_unknown(tmp_path):
    data_dir = str(tmp_path)
    _write_official_template(
        data_dir,
        "with_harvested",
        [
            {
                "name": "harvested_model.safetensors",
                "url": "https://example.com/harvested_model.safetensors",
                "directory": "checkpoints",
            }
        ],
    )

    message = model_guide.guidance_message(
        ["flux1-dev.safetensors", "harvested_model.safetensors", "totally_unknown_model.safetensors"],
        data_dir,
    )

    expected = (
        "無法執行：聯邦裡所有已註冊的 worker 都缺少以下模型（含目前離線的）。"
        "請在 worker 主機下載後放到指定資料夾，worker 會在 10 分鐘內自動掃描並回報，不需重啟。"
        "\n\n"
        "【flux1-dev.safetensors】(22.17 GB)\n"
        "放置路徑：models/diffusion_models/\n"
        "官方載點：https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/flux1-dev.safetensors"
        "（需登入 HuggingFace 並同意 FLUX.1-dev 授權）\n"
        "備份載點：https://storage.googleapis.com/comfyfed-models/models/diffusion_models/flux1-dev.safetensors"
        "\n\n"
        "【harvested_model.safetensors】\n"
        "放置路徑：models/checkpoints/\n"
        "官方載點：https://example.com/harvested_model.safetensors"
        "\n\n"
        "【totally_unknown_model.safetensors】\n"
        "放置路徑：models/<資料夾依節點類型>/\n"
        "官方載點：請向工作流提供者取得下載來源"
    )
    assert message == expected


def test_guidance_message_never_mentions_old_mirror_domain(tmp_path):
    message = model_guide.guidance_message(
        ["flux1-dev.safetensors", "clip_l.safetensors", "unknown.safetensors"], str(tmp_path)
    )
    assert "models.aiinpocket.com" not in message


def test_guidance_summary_is_one_short_line(tmp_path):
    one = model_guide.guidance_summary(["flux1-dev.safetensors"])
    assert one == "缺少模型：flux1-dev.safetensors，無法執行——詳見下方下載指引"

    several = model_guide.guidance_summary(
        ["ae.safetensors", "flux1-dev.safetensors", "clip_l.safetensors"]
    )
    assert several == "缺少模型：ae.safetensors 等 3 項，無法執行——詳見下方下載指引"

    for line in (one, several):
        assert "\n" not in line


def test_missing_nodes_note_names_every_node(tmp_path):
    note = model_guide.missing_nodes_note(["FooLoader", "BarSampler"])
    assert note == (
        "另外，所有 worker 也都缺少節點：FooLoader、BarSampler"
        "——需在 worker 端安裝對應 custom node。"
    )


def test_no_reference_to_aiinpocket_models_domain_anywhere_in_module():
    import inspect

    source = inspect.getsource(model_guide)
    assert "models.aiinpocket.com" not in source
