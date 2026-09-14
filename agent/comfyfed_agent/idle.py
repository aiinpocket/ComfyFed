"""Cross-platform "how long since the human last touched this machine?".

One public function, `seconds_since_input()`, dispatching per `sys.platform`
over ctypes only -- no new dependencies (plan Global Constraints). It never
raises: every failure path (unsupported OS, missing library, headless box,
an API returning an error code) collapses to `None`, and `None` means "this
machine cannot tell", which callers MUST treat as "idle / available" so a
detection failure can never make a worker unschedulable.
"""

from __future__ import annotations

import ctypes
import logging
import os
import sys

logger = logging.getLogger(__name__)


class _LASTINPUTINFO(ctypes.Structure):
    _fields_ = [("cbSize", ctypes.c_uint), ("dwTime", ctypes.c_uint)]


def _win32_seconds() -> float | None:
    """Win32 `GetLastInputInfo`: ticks (ms since boot) of the last input event.

    `GetTickCount` wraps every ~49.7 days, so the subtraction is masked back
    into 32 bits -- otherwise a wrap would yield a hugely negative idle time
    right after the wrap and look like "user active" forever.
    """
    lii = _LASTINPUTINFO()
    lii.cbSize = 8
    if not ctypes.windll.user32.GetLastInputInfo(ctypes.byref(lii)):
        return None
    idle_ms = (ctypes.windll.kernel32.GetTickCount() - lii.dwTime) & 0xFFFFFFFF
    return idle_ms / 1000.0


def _darwin_seconds() -> float | None:
    """CoreGraphics `CGEventSourceSecondsSinceLastEventType`, combined session
    state (1) and any input event type (0xFFFFFFFF)."""
    cg = ctypes.CDLL(
        "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics"
    )
    fn = cg.CGEventSourceSecondsSinceLastEventType
    fn.restype = ctypes.c_double
    fn.argtypes = (ctypes.c_uint32, ctypes.c_uint32)
    return float(fn(1, 0xFFFFFFFF))


class _XScreenSaverInfo(ctypes.Structure):
    _fields_ = [
        ("window", ctypes.c_ulong),
        ("state", ctypes.c_int),
        ("kind", ctypes.c_int),
        ("since", ctypes.c_ulong),
        ("idle", ctypes.c_ulong),
        ("event_mask", ctypes.c_ulong),
    ]


def _linux_seconds() -> float | None:
    """X11 XScreenSaver extension. No `DISPLAY` (a headless box, or a Wayland
    session without XWayland) -> `None` -> always-available."""
    if not os.environ.get("DISPLAY"):
        return None

    x11 = ctypes.CDLL("libX11.so.6")
    xss = ctypes.CDLL("libXss.so.1")

    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XOpenDisplay.argtypes = (ctypes.c_char_p,)
    xss.XScreenSaverAllocInfo.restype = ctypes.POINTER(_XScreenSaverInfo)
    xss.XScreenSaverQueryInfo.argtypes = (
        ctypes.c_void_p,
        ctypes.c_ulong,
        ctypes.POINTER(_XScreenSaverInfo),
    )

    display = x11.XOpenDisplay(None)
    if not display:
        return None

    info = None
    try:
        info = xss.XScreenSaverAllocInfo()
        root = x11.XDefaultRootWindow(ctypes.c_void_p(display))
        if not xss.XScreenSaverQueryInfo(ctypes.c_void_p(display), root, info):
            return None
        return info.contents.idle / 1000.0
    finally:
        if info:
            x11.XFree(info)
        x11.XCloseDisplay(ctypes.c_void_p(display))


def seconds_since_input() -> float | None:
    """Seconds since the last keyboard/mouse input, or `None` if this machine
    cannot tell. Never raises."""
    try:
        if sys.platform == "win32":
            return _win32_seconds()
        if sys.platform == "darwin":
            return _darwin_seconds()
        if sys.platform.startswith("linux"):
            return _linux_seconds()
    except Exception:
        logger.debug("idle: detection failed", exc_info=True)
    return None
