"""Install and report the Apple-MPS quantization shim (`mps_quant_compat`).

2026-09-23: a Mac worker used to be refused every model job because fp8 /
int8 / nvfp4 weights hit missing MPS kernels ("Undefined type Float8_e4m3fn",
"aten::_int_mm is not implemented for MPS"). `mps_quant_compat.py` patches
both at the torch level; dropped into ComfyUI's `custom_nodes/` it loads on
every start and the same fp8 Chroma / int8 MiniMax-H3 workflows an NVIDIA
worker runs then complete on a Mac unchanged (verified on an M4 Pro 64 GB).

This module is the agent-side plumbing around that file:

* `ensure_installed(comfy_dir)` writes (or refreshes) the shim under
  `<comfy_dir>/custom_nodes/comfyfed_mps_compat/__init__.py`. Idempotent; a
  changed file only takes effect after ComfyUI restarts.
* `is_active(comfy_dir)` reads the `state.json` the shim writes when it
  patches torch, and checks that the pid in it is still alive: that is the
  proof the RUNNING ComfyUI has the shim, not merely the disk.
* `report(models_dir)` is what `runner` folds into the hello `hardware` blob
  as `mps_quant_compat` (true/false); `assess.verdict` on the platform lets
  an mps worker take model jobs only when it is true.

The shim source is read from the package file, never imported here -- the
agent's own venv has no torch and importing it would try to patch anyway.
"""

from __future__ import annotations

import json
import logging
import os
import platform
import sys
from importlib import resources

import psutil

logger = logging.getLogger(__name__)

SHIM_MODULE = "mps_quant_compat.py"
CUSTOM_NODE_DIR = "comfyfed_mps_compat"
STATE_FILE = "state.json"
HARDWARE_KEY = "mps_quant_compat"


def shim_source() -> str:
    """The shim file's text as shipped in this agent version."""
    return resources.files("comfyfed_agent").joinpath(SHIM_MODULE).read_text(encoding="utf-8")


def comfy_dir_from_models_dir(models_dir: str | None) -> str | None:
    """`<comfy>/models` -> `<comfy>` when that parent really holds a ComfyUI
    (`custom_nodes/` present); None otherwise. A shared models library
    outside the ComfyUI tree yields None on purpose: we would not know where
    ComfyUI's custom_nodes live and must not guess."""
    if not models_dir:
        return None
    parent = os.path.dirname(os.path.normpath(models_dir))
    if os.path.isdir(os.path.join(parent, "custom_nodes")):
        return parent
    return None


def custom_node_path(comfy_dir: str) -> str:
    return os.path.join(comfy_dir, "custom_nodes", CUSTOM_NODE_DIR, "__init__.py")


def ensure_installed(comfy_dir: str) -> bool:
    """Write the shim into ComfyUI's custom_nodes. Returns True when the file
    was created or its content changed (i.e. ComfyUI needs a restart)."""
    target = custom_node_path(comfy_dir)
    source = shim_source()
    try:
        if os.path.isfile(target):
            with open(target, encoding="utf-8") as fh:
                if fh.read() == source:
                    return False
        os.makedirs(os.path.dirname(target), exist_ok=True)
        tmp = target + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(source)
        os.replace(tmp, target)
    except OSError as exc:
        logger.warning("Could not install the MPS shim at %s: %s", target, exc)
        return False
    logger.info("Installed the MPS quantization shim at %s (ComfyUI restart needed)", target)
    return True


def is_active(comfy_dir: str) -> bool:
    """True when the shim's state marker names a live process AND the file
    on disk is the one this agent ships (an older shim still running counts
    as not active, so the platform never trusts a stale copy)."""
    target = custom_node_path(comfy_dir)
    state_path = os.path.join(os.path.dirname(target), STATE_FILE)
    try:
        with open(target, encoding="utf-8") as fh:
            if fh.read() != shim_source():
                return False
        with open(state_path, encoding="utf-8") as fh:
            state = json.load(fh)
    except (OSError, ValueError):
        return False
    pid = state.get("pid") if isinstance(state, dict) else None
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    return psutil.pid_exists(pid)


def report(models_dir: str | None) -> bool:
    """Hello-time value for `hardware["mps_quant_compat"]`: only a Mac can
    ever say True, and only when the running ComfyUI carries this shim."""
    if platform.system() != "Darwin":
        return False
    comfy_dir = comfy_dir_from_models_dir(models_dir)
    if comfy_dir is None:
        return False
    ensure_installed(comfy_dir)
    return is_active(comfy_dir)


def cli(argv: list[str] | None = None) -> int:
    """`python -m comfyfed_agent.mps_compat <comfy_dir>` -- used by the
    installer on macOS to place the shim before ComfyUI's first start."""
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 1:
        print("usage: python -m comfyfed_agent.mps_compat <ComfyUI dir>", file=sys.stderr)
        return 2
    comfy_dir = args[0]
    if not os.path.isdir(comfy_dir):
        print(f"not a directory: {comfy_dir}", file=sys.stderr)
        return 1
    changed = ensure_installed(comfy_dir)
    print("installed" if changed else "already up to date", custom_node_path(comfy_dir))
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(cli())
