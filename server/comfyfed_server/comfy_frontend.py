"""Fetching and locating the official ComfyUI frontend static bundle.

The embedded workflow editor at `/comfy` is the *stock* ComfyUI frontend --
we do not fork or vendor it. Its release artifact is the PyPI wheel
`comfyui-frontend-package`, which is nothing but the built SPA under
`comfyui_frontend_package/static/`.

Why download it at runtime instead of declaring a pip dependency:

* It is ~24 MB of JavaScript that a headless/API-only ComfyFed deployment
  never needs, and it has no Python code we import.
* Pinning it as a dependency would let a resolver upgrade it silently; the
  panel's compatibility with our `/comfy/api/*` surface is version-sensitive,
  so the operator opts in explicitly with `comfyfed-server fetch-comfy-ui`.

Supply chain: the version AND the wheel's sha256 are pinned as constants
here; the download URL itself is read from PyPI's JSON API (file URLs carry a
content-addressed path prefix, so hard-coding one would rot on a re-upload),
and the bytes are verified against `FRONTEND_SHA256` before anything is
extracted. `--version` overrides the pin and therefore *skips* hash
verification -- the CLI prints a warning saying so.
"""

from __future__ import annotations

import hashlib
import json
import os
import urllib.request
import zipfile
from io import BytesIO

# Pinned release of `comfyui-frontend-package` (PyPI), and the sha256 of its
# `-py3-none-any.whl`. Both were recorded by actually downloading the file.
# To bump: fetch the new wheel, re-record the digest, and re-run the panel
# e2e test.
FRONTEND_VERSION = "1.52.7"
FRONTEND_SHA256 = "3aa5624fa5085f8461d31b7eb88a42ed69a0e783a35bec1c2a33b90fc7660950"

PYPI_JSON_URL = "https://pypi.org/pypi/comfyui-frontend-package/json"

# Everything the wheel ships under this prefix is the built SPA; the rest is
# just `.dist-info` metadata.
_STATIC_PREFIX = "comfyui_frontend_package/static/"

_DIRNAME = "comfy_frontend"

_DOWNLOAD_TIMEOUT = 300


class FetchError(RuntimeError):
    """Anything that stops us producing a verified, extracted frontend."""


def frontend_dir(data_dir: str) -> str:
    return os.path.join(data_dir, _DIRNAME)


def is_populated(data_dir: str) -> bool:
    """True once `<data_dir>/comfy_frontend/index.html` exists.

    The index page, not merely the directory: a half-extracted or manually
    emptied directory should still count as "needs fetching".
    """
    return os.path.isfile(os.path.join(frontend_dir(data_dir), "index.html"))


def wheel_url(version: str) -> str:
    """Look the wheel's download URL up in PyPI's JSON API."""
    try:
        with urllib.request.urlopen(PYPI_JSON_URL, timeout=60) as response:
            index = json.loads(response.read().decode("utf-8"))
    except Exception as exc:  # network/JSON/HTTP -- all equally fatal here
        raise FetchError(f"Could not read the PyPI index: {exc}") from exc

    files = index.get("releases", {}).get(version)
    if not files:
        raise FetchError(f"comfyui-frontend-package has no release {version} on PyPI.")

    for entry in files:
        if entry.get("packagetype") == "bdist_wheel" and entry.get("filename", "").endswith(".whl"):
            return entry["url"]

    raise FetchError(f"comfyui-frontend-package {version} publishes no wheel.")


def download(url: str) -> bytes:
    try:
        with urllib.request.urlopen(url, timeout=_DOWNLOAD_TIMEOUT) as response:
            return response.read()
    except Exception as exc:
        raise FetchError(f"Download failed: {exc}") from exc


def extract_static(wheel_bytes: bytes, dest_dir: str) -> int:
    """Extract the wheel's `static/` tree into `dest_dir`. Returns file count.

    Members are written one by one rather than via `ZipFile.extractall` so
    each destination path can be resolved and confirmed to stay inside
    `dest_dir` (zip-slip): a wheel is an ordinary zip and its member names are
    attacker-controlled in the general case.
    """
    os.makedirs(dest_dir, exist_ok=True)
    root = os.path.realpath(dest_dir)
    written = 0

    with zipfile.ZipFile(BytesIO(wheel_bytes)) as archive:
        for name in archive.namelist():
            if not name.startswith(_STATIC_PREFIX) or name.endswith("/"):
                continue
            relative = name[len(_STATIC_PREFIX):]
            target = os.path.realpath(os.path.join(root, relative))
            if target != root and not target.startswith(root + os.sep):
                raise FetchError(f"Refusing to extract outside the target directory: {name}")

            os.makedirs(os.path.dirname(target), exist_ok=True)
            with archive.open(name) as src, open(target, "wb") as out:
                while True:
                    chunk = src.read(1024 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
            written += 1

    if written == 0:
        raise FetchError(
            f"The wheel contains no `{_STATIC_PREFIX}` files -- is this the right package?"
        )
    if not os.path.isfile(os.path.join(dest_dir, "index.html")):
        raise FetchError("The extracted bundle has no index.html.")
    return written


def fetch(data_dir: str, version: str | None = None) -> dict:
    """Download + verify + extract the frontend into `<data_dir>/comfy_frontend`.

    Returns `{"status": "already_present" | "installed", "version", "dir",
    "files", "verified"}`. `verified` is False when `version` overrode the
    pin, because the pinned sha256 only describes `FRONTEND_VERSION`.
    """
    dest = frontend_dir(data_dir)
    if is_populated(data_dir):
        return {
            "status": "already_present",
            "version": version or FRONTEND_VERSION,
            "dir": dest,
            "files": 0,
            "verified": False,
        }

    pinned = version is None
    wanted = version or FRONTEND_VERSION

    payload = download(wheel_url(wanted))

    if pinned:
        digest = hashlib.sha256(payload).hexdigest()
        if digest != FRONTEND_SHA256:
            raise FetchError(
                f"sha256 mismatch for comfyui-frontend-package {wanted}: "
                f"expected {FRONTEND_SHA256}, got {digest}"
            )

    files = extract_static(payload, dest)
    return {
        "status": "installed",
        "version": wanted,
        "dir": dest,
        "files": files,
        "verified": pinned,
    }
