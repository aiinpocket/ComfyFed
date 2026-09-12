"""`storage.sanitize_path_component` -- the single definition of a safe path segment.

Every place a client-supplied name becomes a path segment routes through this
one function (artifact storage, job-input uploads, the panel's staging area,
and `/comfy/api/view`'s subfolder-as-job-id), so its rules are tested here
rather than once per caller.
"""

import pytest

from comfyfed_server.storage import sanitize_path_component


@pytest.mark.parametrize("value", ["out.png", "a", "ComfyUI_00001_.png", "with space.png", "..hidden"])
def test_accepts_ordinary_names_unchanged(value):
    # Idempotent: sanitizing an already-safe value returns it verbatim.
    assert sanitize_path_component(value) == value
    assert sanitize_path_component(sanitize_path_component(value)) == value


@pytest.mark.parametrize(
    "value",
    ["", ".", "..", "a/b", "a\\b", "../../etc/passwd", "/etc/passwd", "dir/"],
)
def test_rejects_empty_dots_and_separators(value):
    with pytest.raises(ValueError):
        sanitize_path_component(value)


@pytest.mark.parametrize(
    "value",
    [
        "CON",
        "con",
        "Con",
        "PRN",
        "AUX",
        "NUL",
        "nul",
        "COM1",
        "com9",
        "LPT1",
        "lpt9",
        # An extension does not make a device name safe on Windows: `con.png`
        # is still the console, and `nul.json` still discards everything
        # written to it.
        "CON.png",
        "nul.json",
        "com1.txt",
        "LPT3.tar.gz",
    ],
)
def test_rejects_windows_device_names(value):
    """M3: these resolve to devices, not files.

    Rejected on every platform, not just Windows, so a name a Linux-hosted
    ComfyFed accepted does not become unservable when the deployment moves.
    """
    with pytest.raises(ValueError):
        sanitize_path_component(value)


@pytest.mark.parametrize("value", ["report.png.", "report.png ", "name.", "name "])
def test_rejects_trailing_dot_or_space(value):
    """Windows strips these on resolution, so `x.png.` and `x.png` collide."""
    with pytest.raises(ValueError):
        sanitize_path_component(value)


@pytest.mark.parametrize("value", ["console.png", "connect.txt", "communication", "auxiliary.png",
                                   "nullable.json", "com10.txt", "lpt0.txt", "printer.png"])
def test_does_not_over_reject_names_that_merely_start_like_a_device(value):
    """`COM10` and `LPT0` are NOT reserved, and neither is anything whose stem
    is merely longer than a device name."""
    assert sanitize_path_component(value) == value


def test_error_message_names_the_kind_of_component():
    with pytest.raises(ValueError, match="artifact filename"):
        sanitize_path_component("nul.png", what="artifact filename")
