"""Application icon generation (Pillow), matching the frontend blue accent.

Frontend light-theme accent: #0284c7; dark: #3b82f6.
Shape: rounded square with a pen nib (echoing assets/icons/pen.svg).

Pillow is only needed when generating icons, i.e. at build time (backend/build.py)
and never by the packaged app, so it lives in the `build` extra.
"""
from PIL import Image, ImageDraw

ACCENT_LIGHT = (2, 132, 199)      # #0284c7
ACCENT_DARK = (59, 130, 246)      # #3b82f6
PAPER = (248, 250, 252)           # #f8fafc


def make_app_image(size: int = 64, dark: bool = False) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    accent = ACCENT_DARK if dark else ACCENT_LIGHT
    pad = max(2, size // 16)
    radius = size // 5

    # rounded square background
    d.rounded_rectangle([pad, pad, size - pad, size - pad], radius=radius, fill=accent + (255,))

    # pen nib (simplified: white barrel + slanted tip)
    s = size
    ink = PAPER + (255,)
    lw = max(2, s // 12)
    x0, y0 = s * 0.30, s * 0.72
    x1, y1 = s * 0.72, s * 0.30
    d.line([(x0, y0), (x1, y1)], fill=ink, width=lw)
    # tip (solid dot, mirroring the circle in pen.svg)
    r = max(2, s // 14)
    d.ellipse([x1 - r, y1 - r, x1 + r, y1 + r], fill=ink)
    # slanted tail (triangle)
    d.polygon([(x0 - r, y0 + r), (x0 + r, y0 - r), (x0 - r, y0 - r)], fill=ink)

    return img


def save_icon_ico(path, sizes=(16, 24, 32, 48, 64, 128, 256)) -> None:
    """Write the multi-size .ico used by the executables."""
    img = make_app_image(256)
    img.save(path, format="ICO", sizes=[(s, s) for s in sizes])
