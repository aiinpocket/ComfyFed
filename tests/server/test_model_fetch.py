"""Panel "Download" button -> `kind=model_fetch` job (spec 2026-09-19).

Task 1 covers the pure helpers in `comfyfed_server.model_fetch`: the URL
origin allowlist, the HEAD size probe, and the unverified-source manifest
entry signature. Task 4 adds the route-level branch tests below them.
"""

import httpx
import pytest
from nacl.signing import SigningKey

from comfyfed_server import model_fetch


@pytest.mark.parametrize("url,ok", [
    ("https://huggingface.co/Comfy-Org/x/resolve/main/ae.safetensors", True),
    ("https://HUGGINGFACE.co/a/b", True),
    ("https://civitai.com/api/download/models/123", True),
    ("https://huggingface.co.evil.com/x", False),
    ("http://huggingface.co/x", False),
    ("https://storage.googleapis.com/x", False),
    ("not a url", False),
    ("", False),
])
def test_is_trusted_url(url, ok):
    assert model_fetch.is_trusted_url(url) is ok


def test_unverified_payload_shape():
    assert (
        model_fetch.unverified_payload("ae.safetensors", "vae", "https://huggingface.co/x", 335)
        == "ae.safetensors|vae|https://huggingface.co/x|335|unverified"
    )


def test_sign_unverified_entry_verifies_with_platform_key():
    key = SigningKey.generate()
    entry = model_fetch.sign_unverified_entry(
        key, name="ae.safetensors", directory="vae", url="https://huggingface.co/x", size_bytes=335
    )
    assert entry["unverified"] is True and entry["sha256"] is None and entry["backup_url"] is None
    key.verify_key.verify(
        model_fetch.unverified_payload("ae.safetensors", "vae", "https://huggingface.co/x", 335).encode(),
        bytes.fromhex(entry["sig"]),
    )
    assert model_fetch.is_unverified_entry(entry)
    assert not model_fetch.is_unverified_entry({"name": "x", "sha256": "ab" * 32, "size_bytes": 1})


def _client(handler):
    return lambda **kw: httpx.Client(transport=httpx.MockTransport(handler), **kw)


def test_head_size_bytes_follows_redirect_and_reads_content_length():
    def handler(request):
        if request.url.path == "/a":
            return httpx.Response(302, headers={"location": "https://cdn.example/b"})
        return httpx.Response(200, headers={"content-length": "12345"})
    assert model_fetch.head_size_bytes("https://huggingface.co/a", client_factory=_client(handler)) == 12345


@pytest.mark.parametrize("status", [401, 403])
def test_head_size_bytes_gated(status):
    def handler(request):
        return httpx.Response(status)
    with pytest.raises(model_fetch.HeadError) as exc:
        model_fetch.head_size_bytes("https://huggingface.co/a", client_factory=_client(handler))
    assert exc.value.code == "gated"


@pytest.mark.parametrize("resp_kwargs", [
    {"status_code": 404},
    {"status_code": 200},
    {"status_code": 200, "headers": {"content-length": "0"}},
    {"status_code": 200, "headers": {"content-length": "abc"}},
])
def test_head_size_bytes_size_unknown(resp_kwargs):
    def handler(request):
        return httpx.Response(**resp_kwargs)
    with pytest.raises(model_fetch.HeadError) as exc:
        model_fetch.head_size_bytes("https://huggingface.co/a", client_factory=_client(handler))
    assert exc.value.code == "size_unknown"


def test_head_size_bytes_network_error_is_size_unknown():
    def handler(request):
        raise httpx.ConnectError("boom")
    with pytest.raises(model_fetch.HeadError) as exc:
        model_fetch.head_size_bytes("https://huggingface.co/a", client_factory=_client(handler))
    assert exc.value.code == "size_unknown"
