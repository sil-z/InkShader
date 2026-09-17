"""Windows high-DPI declaration, kept free of any GUI import.

Lives in its own module so the desktop path can declare DPI awareness before
creating a window without importing pywebview: the web build (console backend)
must not pull `webview` into the bundle, and this module is the only piece of
the old control window that the shared startup path still needs.
"""
import ctypes
import logging
import sys

log = logging.getLogger("inkshader.dpi")


def enable_dpi_awareness() -> None:
    """Declare per-monitor DPI awareness (Windows only; no-op elsewhere).

    Must run before any window is created, otherwise Windows renders the
    window by bitmap-stretching it and the whole UI looks blurry.
    """
    if sys.platform != "win32":
        return
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # per-monitor DPI aware
    except (AttributeError, OSError):
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception as e:  # noqa: BLE001
            log.debug("DPI awareness could not be declared: %s", e)
