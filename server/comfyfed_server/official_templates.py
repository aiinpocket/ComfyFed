"""Fetching the official ComfyUI workflow-template library from PyPI.

The `/comfy` panel's template picker wants the same starter workflows the
stock ComfyUI frontend ships. Upstream splits that payload across several
PyPI packages instead of one:

* `comfyui-workflow-templates` -- the *meta* package. It has no useful files
  of its own; its `requires_dist` just pins the versions of the packages
  below.
* `comfyui-workflow-templates-core` -- server-side Python loader helpers for
  ComfyUI's own backend. We have our own `/comfy` template serving, so this
  package is never downloaded.
* `comfyui-workflow-templates-json` -- the template index (`index.json`,
  per-language `index.<lang>.json`, `index_logo.json`) and every workflow's
  `<name>.json` graph.
* `comfyui-workflow-templates-media-*` -- the thumbnails/media referenced by
  those workflows (`<name>-1.<ext>`, `<name>-2.<ext>`, ...), split into
  several packages upstream for wheel-size reasons that do not matter to us.

So fetching "the templates" means: read the meta package's `requires_dist`
to learn which `-json` and `-media-*` packages (and exact versions) go with
this release, then download and flatten each of their wheels' `templates/`
trees into one directory -- `-core` is skipped.

Unlike `comfy_frontend.py`'s frontend bundle, there is no single pinned
sha256 baked into this module: the set of sub-packages and their versions
is itself discovered from PyPI at fetch time, so each wheel is verified
against the sha256 PyPI's own JSON API reports for it, not a constant here.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import zipfile
from datetime import datetime, timezone

import httpx

META_PACKAGE = "comfyui-workflow-templates"
META_JSON_URL = f"https://pypi.org/pypi/{META_PACKAGE}/json"

_DIRNAME = "comfy_templates_official"
MANIFEST_NAME = "manifest.json"

# A member is part of the payload we want iff its path has a "/templates/"
# segment somewhere in it (every sub-package wheel nests its files under
# "<pkg>/templates/").
_TEMPLATES_SEGMENT = "/templates/"

_REQUIRES_RE = re.compile(r"^([A-Za-z0-9._-]+)\s*==\s*([A-Za-z0-9.]+)")

_DOWNLOAD_TIMEOUT = 300

# Hard cap per sub-package wheel. The official library has grown new media
# sub-packages before and could again; a runaway/compromised PyPI response
# must not be allowed to fill the disk (or, before this cap existed, memory --
# the old bytearray-buffering `_download` held the whole wheel in RAM before
# writing anything). 512 MB is generous headroom over any real wheel here
# (the -json and -media-* packages today are a few MB to a few tens of MB
# each) while still being a real stop, not a formality.
_MAX_WHEEL_BYTES = 512 * 1024 * 1024


class FetchError(RuntimeError):
    """Anything that stops us producing a verified, extracted template set."""


def official_dir(data_dir: str) -> str:
    return os.path.join(data_dir, _DIRNAME)


def load_manifest(data_dir: str) -> dict | None:
    """Return the manifest written by the last successful `fetch`, or None."""
    path = os.path.join(official_dir(data_dir), MANIFEST_NAME)
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _get_json(url: str) -> dict:
    """Mockable seam: `GET url` and parse the body as JSON."""
    try:
        resp = httpx.get(url, timeout=60, follow_redirects=True)
        resp.raise_for_status()
        return resp.json()
    except Exception as exc:  # network/HTTP/JSON -- all equally fatal here
        raise FetchError(f"Could not read {url}: {exc}") from exc


def _download(url: str) -> tuple[str, str]:
    """Mockable seam: stream `url` to a `NamedTemporaryFile`, hashing as it
    goes, and return `(temp file path, sha256 hex digest)`.

    Streams straight to disk instead of buffering the whole wheel in memory
    (the old `bytearray` approach here) and aborts mid-stream -- deleting the
    partial temp file -- the moment `_MAX_WHEEL_BYTES` is exceeded, rather
    than only checking after a possibly-huge response finished downloading.
    The caller owns the returned file and must remove it once done (`fetch`
    does this in a `finally`, success or failure) so a size check up front
    (e.g. a `Content-Length` header) would not be enough on its own: a
    misbehaving or compromised server can lie about or omit it.
    """
    tmp = tempfile.NamedTemporaryFile(delete=False)
    try:
        try:
            with httpx.stream("GET", url, timeout=_DOWNLOAD_TIMEOUT, follow_redirects=True) as resp:
                resp.raise_for_status()
                hasher = hashlib.sha256()
                total = 0
                for chunk in resp.iter_bytes():
                    total += len(chunk)
                    if total > _MAX_WHEEL_BYTES:
                        raise FetchError(
                            f"下載檔案超過 {_MAX_WHEEL_BYTES // (1024 * 1024)} MB 上限，已中止下載：{url}"
                        )
                    hasher.update(chunk)
                    tmp.write(chunk)
        except FetchError:
            raise
        except Exception as exc:
            raise FetchError(f"Download failed: {exc}") from exc
    except BaseException:
        tmp.close()
        os.unlink(tmp.name)
        raise

    tmp.close()
    return tmp.name, hasher.hexdigest()


def _parse_sub_packages(requires_dist: list[str]) -> dict[str, str]:
    """Parse `name==version` pins out of the meta package's `requires_dist`,
    dropping the `-core` package (see module docstring)."""
    packages: dict[str, str] = {}
    for entry in requires_dist or []:
        match = _REQUIRES_RE.match(entry.strip())
        if not match:
            continue
        name, version = match.group(1), match.group(2)
        if name.endswith("-core"):
            continue
        packages[name] = version
    return packages


def _wheel_url_and_sha256(package_json: dict) -> tuple[str, str]:
    for entry in package_json.get("urls", []):
        if entry.get("packagetype") == "bdist_wheel":
            digest = entry.get("digests", {}).get("sha256")
            url = entry.get("url")
            if url and digest:
                return url, digest
    raise FetchError("No wheel with a sha256 digest found in the PyPI response.")


def _member_basename(name: str) -> str | None:
    """Return the flat filename a zip member should be written as, or None
    if it should be skipped.

    Every wanted member's path contains a "/templates/" segment; we take
    only its final path component (flattening away the sub-package name and
    the "templates/" prefix). A basename() call alone is not a sufficient
    zip-slip guard here: `".../templates/../evil.txt"` also contains the
    "/templates/" substring, and `os.path.basename` of that string is the
    harmless-looking "evil.txt" -- the traversal has already happened by the
    time basename() sees it. So every path segment is checked for "." / ".."
    directly, and the member is rejected outright if any segment is unsafe.
    """
    if name.endswith("/"):
        return None  # directory entry
    if _TEMPLATES_SEGMENT not in ("/" + name):
        return None

    parts = name.split("/")
    if any(part in ("", ".", "..") for part in parts[:-1]):
        return None

    basename = parts[-1]
    if not basename or "/" in basename or "\\" in basename or ".." in basename:
        return None
    return basename


def _extract_templates(wheel_path: str, dest_dir: str) -> int:
    """Flatten every `.../templates/<file>` member of the wheel at
    `wheel_path` into `dest_dir`. Returns the number of files written.

    Opens the wheel straight off disk (rather than the old `BytesIO(bytes)`)
    now that `_download` streams to a temp file instead of buffering the
    whole wheel in memory.
    """
    os.makedirs(dest_dir, exist_ok=True)
    written = 0
    with zipfile.ZipFile(wheel_path) as archive:
        for name in archive.namelist():
            basename = _member_basename(name)
            if basename is None:
                continue
            target = os.path.join(dest_dir, basename)
            with archive.open(name) as src, open(target, "wb") as out:
                shutil.copyfileobj(src, out)
            written += 1
    return written


def fetch(data_dir: str, version: str | None = None) -> dict:
    """Download, verify, and extract the official template library into
    `<data_dir>/comfy_templates_official`, replacing whatever was there.

    Unlike `comfy_frontend.fetch`, this always re-fetches and re-extracts --
    there is no pinned version to short-circuit against, and the set of
    sub-packages can change release to release. Extraction happens into a
    fresh temp directory first and is only swapped into place once every
    sub-package has downloaded and verified cleanly, so a failure partway
    through (a bad sha256, a network error) leaves any previous
    `official_dir` untouched.

    Returns the manifest dict that was also written to
    `<official_dir>/manifest.json`.
    """
    meta_url = META_JSON_URL if version is None else f"https://pypi.org/pypi/{META_PACKAGE}/{version}/json"
    meta = _get_json(meta_url)
    info = meta.get("info", {})
    meta_version = version or info.get("version")
    if not meta_version:
        raise FetchError(f"{META_PACKAGE}: PyPI response has no resolvable version.")

    packages = _parse_sub_packages(info.get("requires_dist") or [])
    if not packages:
        raise FetchError(f"{META_PACKAGE} {meta_version} lists no template sub-packages to fetch.")

    dest = official_dir(data_dir)
    os.makedirs(data_dir, exist_ok=True)
    tmp_dir = tempfile.mkdtemp(prefix=_DIRNAME + ".", dir=data_dir)

    try:
        total_files = 0
        for name, pkg_version in packages.items():
            package_json = _get_json(f"https://pypi.org/pypi/{name}/{pkg_version}/json")
            url, expected_sha256 = _wheel_url_and_sha256(package_json)
            wheel_path, digest = _download(url)
            try:
                if digest != expected_sha256:
                    raise FetchError(
                        f"sha256 mismatch for {name}=={pkg_version}: "
                        f"expected {expected_sha256}, got {digest}"
                    )

                total_files += _extract_templates(wheel_path, tmp_dir)
            finally:
                try:
                    os.unlink(wheel_path)
                except OSError:
                    pass

        if total_files == 0:
            raise FetchError("No template files found in any fetched sub-package wheel.")

        manifest = {
            "meta_version": meta_version,
            "packages": packages,
            "files": total_files,
            "fetched_at": datetime.now(timezone.utc).isoformat(),
        }
        with open(os.path.join(tmp_dir, MANIFEST_NAME), "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2)

        # Atomic swap: drop the old dir (if any) and rename the fully-built
        # temp dir into place. On Windows os.replace cannot target a
        # non-empty directory, so the old one is removed first.
        if os.path.isdir(dest):
            shutil.rmtree(dest)
        os.replace(tmp_dir, dest)
    except BaseException:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise

    return manifest
