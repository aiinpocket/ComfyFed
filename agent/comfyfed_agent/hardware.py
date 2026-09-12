"""Hardware/backend reporting and local model inventory scanning.

Every function here is individually mockable: no test should need a real GPU,
`nvidia-smi`, or network access. `comfy_url` is accepted for symmetry with
other agent modules but not currently used to probe ComfyUI's own hardware
report.
"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess

import psutil

from . import __version__


def _run_nvidia_smi(args: list[str]) -> str:
    result = subprocess.run(
        ["nvidia-smi", *args],
        capture_output=True,
        text=True,
        timeout=5,
        check=True,
    )
    return result.stdout.strip()


def collect_hardware(comfy_url: str) -> dict:
    """Gather this machine's hardware summary for the WS `hello` message."""
    gpu_name = None
    vram_gb = None
    try:
        line = _run_nvidia_smi(
            ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"]
        ).splitlines()[0]
        name, mem_mib = [part.strip() for part in line.split(",")]
        gpu_name = name
        vram_gb = round(float(mem_mib) / 1024.0, 1)
    except Exception:
        pass

    return {
        "gpu_name": gpu_name,
        "vram_gb": vram_gb,
        "cpu": platform.processor() or platform.machine(),
        "cpu_cores": psutil.cpu_count(logical=True),
        "ram_gb": round(psutil.virtual_memory().total / (1024 ** 3), 1),
        "agent_version": __version__,
    }


def detect_backend() -> tuple[str, str]:
    """Detect the compute backend and, if importable, the installed torch version."""
    backend = "cpu"
    try:
        _run_nvidia_smi(["--query-gpu=name", "--format=csv,noheader"])
        backend = "cuda"
    except Exception:
        try:
            subprocess.run(
                ["rocm-smi"], capture_output=True, text=True, timeout=5, check=True
            )
            backend = "rocm"
        except Exception:
            if platform.system() == "Darwin":
                backend = "mps"

    torch_version = ""
    try:
        import torch  # type: ignore

        torch_version = getattr(torch, "__version__", "")
    except Exception:
        pass

    return backend, torch_version


def collect_dynamic(model_dir_or_none: str | None) -> dict:
    """Gather point-in-time free-resource figures for a heartbeat message."""
    free_vram_gb = None
    try:
        line = _run_nvidia_smi(
            ["--query-gpu=memory.free", "--format=csv,noheader,nounits"]
        ).splitlines()[0]
        free_vram_gb = round(float(line.strip()) / 1024.0, 1)
    except Exception:
        pass

    free_ram_gb = None
    try:
        free_ram_gb = round(psutil.virtual_memory().available / (1024 ** 3), 1)
    except Exception:
        pass

    free_disk_gb = None
    try:
        disk_path = model_dir_or_none if model_dir_or_none else os.getcwd()
        free_disk_gb = round(shutil.disk_usage(disk_path).free / (1024 ** 3), 1)
    except Exception:
        pass

    return {
        "free_vram_gb": free_vram_gb,
        "free_ram_gb": free_ram_gb,
        "free_disk_gb": free_disk_gb,
    }


def scan_models(models_dir: str) -> list[dict]:
    """Walk `models_dir` and return the local model inventory.

    Returns `[{"name": "relative/posix/path", "size": <GB>}, ...]` where
    `size` is the file size in **gigabytes**, rounded to 3 decimal places
    (~1 MB resolution) -- NOT bytes.

    The unit matters: this list goes out as the WS `inventory` message, and
    the server's VRAM estimate and free-disk headroom checks all work in GB
    (as do `collect_hardware`'s vram_gb/ram_gb and `collect_dynamic`'s
    free_*_gb). Reporting bytes here would inflate every estimate by ~10^9.
    """
    results: list[dict] = []
    if not models_dir or not os.path.isdir(models_dir):
        return results

    for root, _dirs, files in os.walk(models_dir):
        for filename in files:
            full_path = os.path.join(root, filename)
            try:
                size_bytes = os.path.getsize(full_path)
            except OSError:
                continue
            rel_path = os.path.relpath(full_path, models_dir)
            results.append(
                {
                    "name": rel_path.replace(os.sep, "/"),
                    "size": round(size_bytes / (1024 ** 3), 3),
                }
            )

    return results
