"""2026-09-23: the agent-side plumbing for the Apple MPS quantization shim."""

import json
import os

import pytest

from comfyfed_agent import mps_compat


def _comfy_tree(tmp_path):
    comfy = tmp_path / "ComfyUI"
    (comfy / "custom_nodes").mkdir(parents=True)
    (comfy / "models").mkdir()
    return comfy


def test_shim_source_is_the_packaged_module_and_registers_no_nodes():
    src = mps_compat.shim_source()
    assert "def install()" in src
    assert "NODE_CLASS_MAPPINGS" in src


def test_comfy_dir_is_the_parent_of_models_only_when_it_holds_custom_nodes(tmp_path):
    comfy = _comfy_tree(tmp_path)
    assert mps_compat.comfy_dir_from_models_dir(str(comfy / "models")) == str(comfy)
    shared = tmp_path / "shared_models"
    shared.mkdir()
    assert mps_compat.comfy_dir_from_models_dir(str(shared)) is None
    assert mps_compat.comfy_dir_from_models_dir(None) is None


def test_ensure_installed_writes_once_and_refreshes_a_stale_copy(tmp_path):
    comfy = _comfy_tree(tmp_path)
    assert mps_compat.ensure_installed(str(comfy)) is True
    target = mps_compat.custom_node_path(str(comfy))
    assert open(target, encoding="utf-8").read() == mps_compat.shim_source()
    assert mps_compat.ensure_installed(str(comfy)) is False
    with open(target, "w", encoding="utf-8") as fh:
        fh.write("# old shim")
    assert mps_compat.ensure_installed(str(comfy)) is True
    assert open(target, encoding="utf-8").read() == mps_compat.shim_source()


def test_is_active_needs_the_current_file_and_a_live_pid(tmp_path):
    comfy = _comfy_tree(tmp_path)
    assert mps_compat.is_active(str(comfy)) is False  # nothing installed
    mps_compat.ensure_installed(str(comfy))
    assert mps_compat.is_active(str(comfy)) is False  # no state.json yet
    state = os.path.join(os.path.dirname(mps_compat.custom_node_path(str(comfy))), mps_compat.STATE_FILE)
    with open(state, "w", encoding="utf-8") as fh:
        json.dump({"pid": os.getpid(), "torch": "2.14.0"}, fh)
    assert mps_compat.is_active(str(comfy)) is True
    with open(state, "w", encoding="utf-8") as fh:
        json.dump({"pid": 2**22 + 12345}, fh)  # almost surely dead
    assert mps_compat.is_active(str(comfy)) is False
    with open(state, "w", encoding="utf-8") as fh:
        fh.write("garbage")
    assert mps_compat.is_active(str(comfy)) is False


def test_is_active_is_false_while_an_older_shim_is_the_one_running(tmp_path):
    comfy = _comfy_tree(tmp_path)
    mps_compat.ensure_installed(str(comfy))
    target = mps_compat.custom_node_path(str(comfy))
    state = os.path.join(os.path.dirname(target), mps_compat.STATE_FILE)
    with open(state, "w", encoding="utf-8") as fh:
        json.dump({"pid": os.getpid()}, fh)
    with open(target, "w", encoding="utf-8") as fh:
        fh.write("# older shim still loaded in ComfyUI")
    assert mps_compat.is_active(str(comfy)) is False


def test_report_is_false_off_macos_and_true_on_a_mac_with_a_live_shim(tmp_path, monkeypatch):
    comfy = _comfy_tree(tmp_path)
    monkeypatch.setattr(mps_compat.platform, "system", lambda: "Linux")
    assert mps_compat.report(str(comfy / "models")) is False
    monkeypatch.setattr(mps_compat.platform, "system", lambda: "Darwin")
    assert mps_compat.report(None) is False
    assert mps_compat.report(str(comfy / "models")) is False  # installed now, not running
    assert os.path.isfile(mps_compat.custom_node_path(str(comfy)))
    state = os.path.join(os.path.dirname(mps_compat.custom_node_path(str(comfy))), mps_compat.STATE_FILE)
    with open(state, "w", encoding="utf-8") as fh:
        json.dump({"pid": os.getpid()}, fh)
    assert mps_compat.report(str(comfy / "models")) is True


def test_cli_installs_into_the_given_dir(tmp_path, capsys):
    comfy = _comfy_tree(tmp_path)
    assert mps_compat.cli([str(comfy)]) == 0
    assert "installed" in capsys.readouterr().out
    assert mps_compat.cli([str(comfy)]) == 0
    assert "already up to date" in capsys.readouterr().out
    assert mps_compat.cli([]) == 2
    assert mps_compat.cli([str(tmp_path / "nope")]) == 1


# --- 2026-09-23 cross-backend §4: a Mac reports its unified memory as VRAM --


def test_collect_hardware_on_darwin_reports_unified_memory_as_vram(monkeypatch):
    from comfyfed_agent import hardware

    monkeypatch.setattr(hardware.platform, "system", lambda: "Darwin")
    monkeypatch.setattr(hardware, "_run_nvidia_smi", lambda args: (_ for _ in ()).throw(FileNotFoundError()))
    monkeypatch.setattr(hardware, "_apple_chip_name", lambda: "Apple M4 Pro")
    hw = hardware.collect_hardware("http://127.0.0.1:8188")
    assert hw["unified_memory"] is True
    assert hw["gpu_name"] == "Apple M4 Pro"
    assert hw["vram_gb"] == hw["ram_gb"] > 0
    dyn = hardware.collect_dynamic(None)
    assert dyn["free_vram_gb"] == dyn["free_ram_gb"]


def test_collect_hardware_off_darwin_keeps_vram_unknown_without_nvidia(monkeypatch):
    from comfyfed_agent import hardware

    monkeypatch.setattr(hardware.platform, "system", lambda: "Linux")
    monkeypatch.setattr(hardware, "_run_nvidia_smi", lambda args: (_ for _ in ()).throw(FileNotFoundError()))
    hw = hardware.collect_hardware("http://127.0.0.1:8188")
    assert hw["unified_memory"] is False and hw["vram_gb"] is None and hw["gpu_name"] is None
