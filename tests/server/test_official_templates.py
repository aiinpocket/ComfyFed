"""`comfyfed-server fetch-comfy-templates` internals: split-package fetch,
flat template extraction, zip-slip guard, manifest, and idempotent re-fetch.

No network: PyPI responses are canned dicts and the sub-package wheels are
tiny in-memory zips, injected through the module's two mockable seams
`_get_json` and `_download`.
"""

from __future__ import annotations

import hashlib
import os
import tempfile
import zipfile
from io import BytesIO

import pytest

from comfyfed_server import official_templates


def _wheel(members: dict) -> bytes:
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, content in members.items():
            archive.writestr(name, content)
    return buffer.getvalue()


_JSON_WHEEL = _wheel(
    {
        "comfyui_workflow_templates_json/templates/index.json": '{"a": 1}',
        "comfyui_workflow_templates_json/templates/foo.json": '{"b": 2}',
        "comfyui_workflow_templates_json/templates/foo-1.webp": "binarybytes",
        # Zip-slip attempt: "/templates/" is a substring of this member's
        # path, but ".." is a real path segment in it -- must be skipped,
        # and "evil.txt" must never land anywhere (not even flattened into
        # official_dir under its basename).
        "comfyui_workflow_templates_json/templates/../evil.txt": "pwned",
    }
)

_MEDIA_WHEEL = _wheel(
    {
        "comfyui_workflow_templates_media_other/templates/foo-2.webp": "morebytes",
    }
)

_REQUIRES_DIST = [
    "comfyui-workflow-templates-json==0.1.63",
    "comfyui-workflow-templates-core==0.3.337",
    "comfyui-workflow-templates-media-other==0.1.0",
]


def _meta_json(requires_dist=_REQUIRES_DIST, version="0.1.63"):
    return {"info": {"version": version, "requires_dist": requires_dist}}


def _pkg_json(url: str, payload: bytes):
    return {
        "urls": [
            {
                "packagetype": "bdist_wheel",
                "filename": "pkg.whl",
                "url": url,
                "digests": {"sha256": hashlib.sha256(payload).hexdigest()},
            }
        ]
    }


def _fake_download_for(downloads: dict):
    """Build a `_download` fake matching the real seam's contract: writes
    `payload` to a temp file and returns `(path, sha256_hex)`."""

    def _fake_download(url):
        if url not in downloads:
            raise AssertionError(f"unexpected _download url: {url}")
        payload = downloads[url]
        tmp = tempfile.NamedTemporaryFile(delete=False)
        tmp.write(payload)
        tmp.close()
        return tmp.name, hashlib.sha256(payload).hexdigest()

    return _fake_download


def _install_fakes(monkeypatch, *, meta=None, core_should_not_be_fetched=True):
    meta = meta if meta is not None else _meta_json()
    json_url = "http://example/json-pkg.whl"
    media_url = "http://example/media-pkg.whl"

    responses = {
        official_templates.META_JSON_URL: meta,
        "https://pypi.org/pypi/comfyui-workflow-templates-json/0.1.63/json": _pkg_json(
            json_url, _JSON_WHEEL
        ),
        "https://pypi.org/pypi/comfyui-workflow-templates-media-other/0.1.0/json": _pkg_json(
            media_url, _MEDIA_WHEEL
        ),
    }
    downloads = {json_url: _JSON_WHEEL, media_url: _MEDIA_WHEEL}

    seen_urls = []

    def _fake_get_json(url):
        seen_urls.append(url)
        if core_should_not_be_fetched and "core" in url:
            raise AssertionError(f"-core package must never be fetched: {url}")
        if url not in responses:
            raise AssertionError(f"unexpected _get_json url: {url}")
        return responses[url]

    monkeypatch.setattr(official_templates, "_get_json", _fake_get_json)
    monkeypatch.setattr(official_templates, "_download", _fake_download_for(downloads))
    return seen_urls


def test_fetch_extracts_templates_flat_into_official_dir(tmp_path, monkeypatch):
    _install_fakes(monkeypatch)
    data_dir = str(tmp_path)

    manifest = official_templates.fetch(data_dir)

    out = official_templates.official_dir(data_dir)
    assert os.path.isfile(os.path.join(out, "index.json"))
    assert os.path.isfile(os.path.join(out, "foo.json"))
    assert os.path.isfile(os.path.join(out, "foo-1.webp"))
    assert os.path.isfile(os.path.join(out, "foo-2.webp"))
    assert manifest["files"] == 4  # json wheel's 3 good members + media wheel's 1 (evil.txt excluded)


def test_fetch_skips_traversing_member_and_writes_nothing_outside(tmp_path, monkeypatch):
    _install_fakes(monkeypatch)
    data_dir = str(tmp_path)

    official_templates.fetch(data_dir)

    out = official_templates.official_dir(data_dir)
    assert not os.path.exists(os.path.join(out, "evil.txt"))
    assert not os.path.exists(os.path.join(str(tmp_path), "evil.txt"))
    for root, _dirs, files in os.walk(data_dir):
        assert "evil.txt" not in files


def test_fetch_writes_manifest_with_package_pins(tmp_path, monkeypatch):
    _install_fakes(monkeypatch)
    data_dir = str(tmp_path)

    manifest = official_templates.fetch(data_dir)

    assert manifest["packages"] == {
        "comfyui-workflow-templates-json": "0.1.63",
        "comfyui-workflow-templates-media-other": "0.1.0",
    }
    assert manifest["meta_version"] == "0.1.63"
    assert "fetched_at" in manifest

    loaded = official_templates.load_manifest(data_dir)
    assert loaded == manifest


def test_fetch_never_downloads_the_core_package(tmp_path, monkeypatch):
    seen_urls = _install_fakes(monkeypatch)
    official_templates.fetch(str(tmp_path))
    assert not any("core" in url for url in seen_urls)


def test_fetch_raises_on_sha256_mismatch_and_leaves_official_dir_untouched(tmp_path, monkeypatch):
    _install_fakes(monkeypatch)
    data_dir = str(tmp_path)

    # Corrupt the download seam so bytes no longer match the digest PyPI
    # claimed for the -json package.
    monkeypatch.setattr(
        official_templates,
        "_download",
        _fake_download_for(
            {"http://example/json-pkg.whl": b"corrupted", "http://example/media-pkg.whl": _MEDIA_WHEEL}
        ),
    )

    with pytest.raises(official_templates.FetchError, match="sha256 mismatch"):
        official_templates.fetch(data_dir)

    assert not os.path.exists(official_templates.official_dir(data_dir))
    assert official_templates.load_manifest(data_dir) is None


def test_fetch_rerun_replaces_stale_content(tmp_path, monkeypatch):
    _install_fakes(monkeypatch)
    data_dir = str(tmp_path)
    official_templates.fetch(data_dir)
    out = official_templates.official_dir(data_dir)
    assert os.path.isfile(os.path.join(out, "foo.json"))

    # Second release drops foo.json/foo-1.webp, adds bar.json.
    smaller_wheel = _wheel(
        {
            "comfyui_workflow_templates_json/templates/index.json": '{"a": 1}',
            "comfyui_workflow_templates_json/templates/bar.json": '{"c": 3}',
        }
    )
    json_url = "http://example/json-pkg-2.whl"
    media_url = "http://example/media-pkg.whl"
    monkeypatch.setattr(
        official_templates,
        "_get_json",
        lambda url: {
            official_templates.META_JSON_URL: _meta_json(),
            "https://pypi.org/pypi/comfyui-workflow-templates-json/0.1.63/json": _pkg_json(
                json_url, smaller_wheel
            ),
            "https://pypi.org/pypi/comfyui-workflow-templates-media-other/0.1.0/json": _pkg_json(
                media_url, _MEDIA_WHEEL
            ),
        }[url],
    )
    monkeypatch.setattr(
        official_templates,
        "_download",
        _fake_download_for({json_url: smaller_wheel, media_url: _MEDIA_WHEEL}),
    )

    official_templates.fetch(data_dir)

    assert os.path.isfile(os.path.join(out, "bar.json"))
    assert not os.path.exists(os.path.join(out, "foo.json"))
    assert not os.path.exists(os.path.join(out, "foo-1.webp"))


# --- Task 7: streaming download with a size cap -------------------------


class _FakeStreamResponse:
    """Stands in for the `httpx.stream(...)` context manager: yields fixed
    chunks and never raises from `raise_for_status`."""

    def __init__(self, chunks):
        self._chunks = chunks

    def raise_for_status(self):
        pass

    def iter_bytes(self):
        yield from self._chunks

    def __enter__(self):
        return self

    def __exit__(self, *exc_info):
        return False


def test_download_streams_to_a_temp_file_and_hashes_it(monkeypatch):
    payload = b"a" * 1000 + b"b" * 1000
    chunks = [payload[:1000], payload[1000:]]

    monkeypatch.setattr(
        official_templates.httpx, "stream", lambda *a, **k: _FakeStreamResponse(chunks)
    )

    path, digest = official_templates._download("http://example/some.whl")
    try:
        assert digest == hashlib.sha256(payload).hexdigest()
        with open(path, "rb") as f:
            assert f.read() == payload
    finally:
        os.unlink(path)


def test_download_cap_is_512mb():
    assert official_templates._MAX_WHEEL_BYTES == 512 * 1024 * 1024


def test_download_aborts_mid_stream_past_the_cap_and_cleans_up(monkeypatch):
    # A small cap (rather than the real 512 MB) keeps this test fast and
    # light on memory while still proving the abort happens mid-stream --
    # partway through the second chunk -- not only after a full (and,
    # pre-Task-7, unbounded) download completed.
    monkeypatch.setattr(official_templates, "_MAX_WHEEL_BYTES", 150)
    chunks = [b"x" * 100, b"y" * 100, b"z" * 100]  # crosses 150 bytes in chunk 2

    written_paths = []
    real_named_temp_file = tempfile.NamedTemporaryFile

    def _tracking_named_temp_file(*args, **kwargs):
        f = real_named_temp_file(*args, **kwargs)
        written_paths.append(f.name)
        return f

    monkeypatch.setattr(
        official_templates.httpx, "stream", lambda *a, **k: _FakeStreamResponse(chunks)
    )
    monkeypatch.setattr(official_templates.tempfile, "NamedTemporaryFile", _tracking_named_temp_file)

    with pytest.raises(official_templates.FetchError, match="上限，已中止下載"):
        official_templates._download("http://example/huge.whl")

    assert written_paths and not os.path.exists(written_paths[0])


def test_fetch_aborts_with_zh_tw_error_when_a_sub_package_wheel_is_oversize(tmp_path, monkeypatch):
    """`fetch()` propagates `_download`'s cap error untouched (it already
    carries the zh-TW message) and leaves no `official_dir` behind, same
    guarantee as the sha256-mismatch path."""
    _install_fakes(monkeypatch)
    data_dir = str(tmp_path)

    def _fake_download(url):
        if "json-pkg" in url:
            raise official_templates.FetchError(
                f"下載檔案超過 {official_templates._MAX_WHEEL_BYTES // (1024 * 1024)} MB 上限，已中止下載：{url}"
            )
        return _fake_download_for({url: _MEDIA_WHEEL})(url)

    monkeypatch.setattr(official_templates, "_download", _fake_download)

    with pytest.raises(official_templates.FetchError, match="512 MB"):
        official_templates.fetch(data_dir)

    assert not os.path.exists(official_templates.official_dir(data_dir))


def test_fetch_with_explicit_version_queries_that_release(tmp_path, monkeypatch):
    data_dir = str(tmp_path)
    seen_urls = []
    meta_url = "https://pypi.org/pypi/comfyui-workflow-templates/0.9.0/json"

    def _fake_get_json(url):
        seen_urls.append(url)
        if url == meta_url:
            return _meta_json(requires_dist=["comfyui-workflow-templates-media-other==0.1.0"], version="0.9.0")
        return _pkg_json("http://example/media-pkg.whl", _MEDIA_WHEEL)

    monkeypatch.setattr(official_templates, "_get_json", _fake_get_json)
    monkeypatch.setattr(
        official_templates, "_download", _fake_download_for({"http://example/media-pkg.whl": _MEDIA_WHEEL})
    )

    manifest = official_templates.fetch(data_dir, version="0.9.0")
    assert manifest["meta_version"] == "0.9.0"
    assert meta_url in seen_urls
