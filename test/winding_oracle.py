"""Winding-number oracle for the example project's paths.

Independent of Paper.js and of the app: flattens the cubic segments of a path's
skeleton into polylines and samples the winding number on a grid. Used to state
the correct region (nonzero rule) so the renderer can be judged against a number
rather than against a screenshot.

Usage:  python test/winding_oracle.py
"""
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT.parent / "example"


def flatten_cubic(p0, p1, p2, p3, steps=48):
    pts = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        x = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0]
        y = u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
        pts.append((x, y))
    return pts


def ring_polyline(vertices, closed=True):
    n = len(vertices)
    out = [ring_segments(vertices, i)[0] for i in range(n)]
    # stitch
    pts = []
    for i in range(n):
        seg = flatten_cubic(*ring_segments(vertices, i))
        pts.extend(seg[:-1])
    return pts


def ring_segments(vertices, i):
    a = vertices[i]
    b = vertices[(i + 1) % len(vertices)]
    p0 = (a["x"], a["y"])
    p1 = (a["control_2"]["x"], a["control_2"]["y"])
    p2 = (b["control_1"]["x"], b["control_1"]["y"])
    p3 = (b["x"], b["y"])
    return p0, p1, p2, p3


def signed_area(vertices):
    """Exact signed area contributed by the cubic segments (shoelace integral)."""
    n = len(vertices)
    A = 0.0
    for i in range(n):
        x0, y0, x1, y1, x2, y2, x3, y3 = (c for seg in [ring_segments(vertices, i)] for c in
                                          (seg[0][0], seg[0][1], seg[1][0], seg[1][1],
                                           seg[2][0], seg[2][1], seg[3][0], seg[3][1]))
        A += (x0 * (-6 * y0 - 3 * y1 + 3 * y2 + 6 * y3)
              + x1 * (-3 * y0 - 8 * y1 - 3 * y2 + y3)
              + x2 * (3 * y0 - 3 * y1 - 8 * y2 - 3 * y3)
              + x3 * (6 * y0 + y1 - 3 * y2 - 6 * y3)) / 20.0
    return A


def winding_at(polyline, px, py):
    """Winding number of a closed polyline around (px, py)."""
    w = 0
    n = len(polyline)
    for i in range(n):
        x0, y0 = polyline[i]
        x1, y1 = polyline[(i + 1) % n]
        if y0 <= py:
            if y1 > py and (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0) > 0:
                w += 1
        else:
            if y1 <= py and (x1 - x0) * (py - y0) - (px - x0) * (y1 - y0) < 0:
                w -= 1
    return w


def render(rings, w=64, h=32, label=""):
    xs = [p[0] for r in rings for p in r]
    ys = [p[1] for r in rings for p in r]
    minx, maxx = min(xs), max(xs)
    miny, maxy = min(ys), max(ys)
    padx = (maxx - minx) * 0.05 or 1
    pady = (maxy - miny) * 0.05 or 1
    minx -= padx; maxx += padx; miny -= pady; maxy += pady
    print(f"--- {label}  signedarea={sum(signed_area(v) for v in rings[0][1]) if False else ''}")
    counts = {}
    lines = []
    for gy in range(h):
        row = []
        for gx in range(w):
            # screen y grows downward for display
            px = minx + (maxx - minx) * (gx + 0.5) / w
            py = maxy - (maxy - miny) * (gy + 0.5) / h
            wn = sum(winding_at(r, px, py) for r in rings)
            counts[wn] = counts.get(wn, 0) + 1
            row.append("." if wn == 0 else ("#" if wn > 0 else "o"))
        lines.append("".join(row))
    print("\n".join(lines))
    print("winding histogram:", dict(sorted(counts.items())))


def main():
    with open(EXAMPLES / "bug_test.json", encoding="utf-8") as f:
        doc = json.load(f)
    children = doc["glyphs"]["zero"]["children"]
    rings = []
    for ch in children:
        v = ch["vertices"]
        rings.append((ch["name"], v, ring_polyline(v)))
        print(f"{ch['name']}: verts={len(v)} signedArea={signed_area(v):.1f} "
              f"cw_setting={ch['smart_stroke_clockwise']}")
    print()
    for name, v, poly in rings:
        render([poly], label=name)


if __name__ == "__main__":
    main()
