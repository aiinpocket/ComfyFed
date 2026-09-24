"""MPS compatibility shim for quantized model weights (fp8 / int8 / nvfp4).

Apple's MPS backend (torch 2.14) can *store* float8 tensors but cannot cast
them to another dtype, and has no `aten::_int_mm`. ComfyUI already routes
these formats through its "emulated" (dequantize-then-bf16-matmul) path on
MPS, but two kernels in that path still hit the missing ops:

* comfy_kitchen `dequantize_per_tensor_fp8` / `dequantize_nvfp4` call
  `fp8_tensor.to(bf16)`  -> "Undefined type Float8_e4m3fn"
* `comfy.ops.linear_input_act` bypasses the disabled-format check and calls
  `int8_linear` -> `torch._int_mm` -> NotImplementedError on MPS

This module patches both at the torch level, so it covers every caller:

* `Tensor.to/float/half/bfloat16` on an fp8 tensor that lives on MPS decode
  through a 256-entry lookup table (exact: fp8 has 256 values).
* Casting *to* fp8 on MPS round-trips through the CPU.
* `torch._int_mm` on MPS is computed as an fp32 matmul rounded to int32
  (exact up to |sum| < 2**24, ~1e-7 relative error beyond that).

Load it as early as possible (custom node, sitecustomize, or `-c import`).
"""
from __future__ import annotations

import functools
import logging

import torch

_LOG = logging.getLogger("mps_quant_compat")

_FP8_DTYPES = tuple(
    d for d in (
        getattr(torch, "float8_e4m3fn", None),
        getattr(torch, "float8_e5m2", None),
        getattr(torch, "float8_e4m3fnuz", None),
        getattr(torch, "float8_e5m2fnuz", None),
        getattr(torch, "float8_e8m0fnu", None),
    )
    if d is not None
)
_LUT_CACHE: dict[tuple[torch.dtype, torch.device, torch.dtype], torch.Tensor] = {}
_PATCHED = False


def _is_mps(t: torch.Tensor) -> bool:
    return t.device.type == "mps"


def _lut(src: torch.dtype, device: torch.device, dst: torch.dtype) -> torch.Tensor:
    key = (src, device, dst)
    lut = _LUT_CACHE.get(key)
    if lut is None:
        # Build on CPU where fp8 casts exist, then ship the 256 values over.
        codes = torch.arange(256, dtype=torch.uint8)
        lut = codes.view(src).to(torch.float32).to(dst).to(device)
        _LUT_CACHE[key] = lut
    return lut


def fp8_decode(x: torch.Tensor, dtype: torch.dtype) -> torch.Tensor:
    """Exact fp8 -> `dtype` decode via table lookup, works on MPS."""
    lut = _lut(x.dtype, x.device, dtype)
    idx = x.contiguous().view(torch.uint8).to(torch.int32)
    return lut[idx]


def fp8_encode(x: torch.Tensor, dtype: torch.dtype) -> torch.Tensor:
    """`dtype` -> fp8 on MPS via a CPU round-trip (rare path)."""
    return x.detach().to("cpu").to(dtype).to(x.device)


def _parse_to_args(args, kwargs):
    """Return (device, dtype) requested by a Tensor.to(...) call, or (None, None)."""
    dtype = kwargs.get("dtype")
    device = kwargs.get("device")
    for a in args:
        if isinstance(a, torch.dtype):
            dtype = a
        elif isinstance(a, (torch.device, str)):
            device = a
        elif isinstance(a, torch.Tensor):
            dtype = a.dtype
            device = a.device
    return device, dtype


_orig_to = torch.Tensor.to


@functools.wraps(_orig_to)
def _patched_to(self, *args, **kwargs):
    device, dtype = _parse_to_args(args, kwargs)
    if dtype is None or dtype == self.dtype:
        return _orig_to(self, *args, **kwargs)
    src_fp8 = self.dtype in _FP8_DTYPES
    dst_fp8 = dtype in _FP8_DTYPES
    if not (src_fp8 or dst_fp8):
        return _orig_to(self, *args, **kwargs)
    target_dev = torch.device(device) if device is not None else self.device
    on_mps = _is_mps(self) or target_dev.type == "mps"
    if not on_mps:
        return _orig_to(self, *args, **kwargs)
    if src_fp8 and dst_fp8:
        # fp8 -> other fp8: decode to fp32 then encode.
        out = fp8_encode(fp8_decode(self, torch.float32), dtype)
    elif src_fp8:
        src = self if _is_mps(self) else _orig_to(self, target_dev)
        out = fp8_decode(src, dtype)
    else:
        out = fp8_encode(self, dtype)
    return out if out.device == target_dev else _orig_to(out, target_dev)


def _make_cast(name: str, dtype: torch.dtype):
    orig = getattr(torch.Tensor, name)

    @functools.wraps(orig)
    def cast(self, *args, **kwargs):
        if self.dtype in _FP8_DTYPES and _is_mps(self):
            return fp8_decode(self, dtype)
        return orig(self, *args, **kwargs)

    return cast


_orig_int_mm = torch._int_mm


@functools.wraps(_orig_int_mm)
def _patched_int_mm(a: torch.Tensor, b: torch.Tensor, *args, **kwargs):
    if not (_is_mps(a) or _is_mps(b)):
        return _orig_int_mm(a, b, *args, **kwargs)
    # fp32 accumulate: products of int8 are exact, sums are exact below 2**24.
    return torch.mm(a.to(torch.float32), b.to(torch.float32)).round_().to(torch.int32)


def install() -> bool:
    """Apply the patches once. Returns True when MPS is present and patched."""
    global _PATCHED
    if _PATCHED:
        return True
    if not (hasattr(torch.backends, "mps") and torch.backends.mps.is_available()):
        return False
    torch.Tensor.to = _patched_to
    torch.Tensor.float = _make_cast("float", torch.float32)
    torch.Tensor.half = _make_cast("half", torch.float16)
    torch.Tensor.bfloat16 = _make_cast("bfloat16", torch.bfloat16)
    torch._int_mm = _patched_int_mm
    _PATCHED = True
    _LOG.info("mps_quant_compat: fp8 decode + int8 matmul shims installed")
    _write_state()
    return True


def _write_state() -> None:
    """Drop a small JSON next to this file so an outside process (the
    ComfyFed agent) can tell the shim is active in the running ComfyUI."""
    import json
    import os
    import time

    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "state.json")
    try:
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(
                {"pid": os.getpid(), "torch": torch.__version__, "installed_at": time.time()},
                fh,
            )
    except OSError as exc:  # never break ComfyUI startup over a marker file
        _LOG.warning("mps_quant_compat: could not write %s: %s", path, exc)


install()

# ComfyUI custom-node protocol: a module with no nodes is still imported.
NODE_CLASS_MAPPINGS: dict = {}
NODE_DISPLAY_NAME_MAPPINGS: dict = {}
