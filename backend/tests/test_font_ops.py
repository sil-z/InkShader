"""后端字体操作的单元测试（font_ops）。

覆盖四类不变量：

1. UFO zip 读写 —— 自定义 GLIF 属性剥离、往返保形；
2. direction 校正 —— 外轮廓逆时针 / 内孔顺时针（PostScript 约定），开放轮廓跳过；
3. remove overlap —— 重叠合并、**内孔保留**（并集不等于填洞）；
4. 导出 —— OTF/TTF 的 sfnt 签名、表结构、字形可解析。

不依赖 pytest 特有功能（只用 assert），因此也可以被最小 harness 直接调用。
"""
from __future__ import annotations

import io
import zipfile

import ufoLib2
from fontTools.pens.areaPen import AreaPen
from fontTools.ttLib import TTFont

from inkshader import font_ops

# ── fixture 构造 ──────────────────────────────────────────────────────────


def _rect(x, y, w, h, *, clockwise=False):
    """矩形顶点（Y-up）。clockwise=False 即逆时针（面积为正）。"""
    pts = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
    return pts[::-1] if clockwise else pts


def _draw_rect(pen, x, y, w, h, *, clockwise=False):
    pen.beginPath()
    for pt in _rect(x, y, w, h, clockwise=clockwise):
        pen.addPoint(pt, segmentType="line")
    pen.endPath()


def _draw_open(pen, points):
    pen.beginPath()
    for i, pt in enumerate(points):
        pen.addPoint(pt, segmentType="move" if i == 0 else "line")
    pen.endPath()


def _new_font():
    font = ufoLib2.Font()
    font.info.unitsPerEm = 1000
    font.info.familyName = "InkShader Test"
    font.info.styleName = "Regular"
    font.info.ascender = 800
    font.info.descender = -200
    return font


def _areas(glyph):
    """每个轮廓的有向面积（fontTools AreaPen，Y-up，逆时针为正）。"""
    values = []
    for contour in glyph:
        pen = AreaPen()
        contour.draw(pen)
        values.append(pen.value)
    return values


def _shoelace_canvas(vertices):
    """画布坐标（Y-down）顶点的有向面积。"""
    total = 0.0
    n = len(vertices)
    for i in range(n):
        x1, y1 = vertices[i]["x"], vertices[i]["y"]
        x2, y2 = vertices[(i + 1) % n]["x"], vertices[(i + 1) % n]["y"]
        total += x1 * y2 - x2 * y1
    return total / 2


def _square_path(x, y, size, *, canvas_clockwise=False):
    pts = [(x, y), (x + size, y), (x + size, y + size), (x, y + size)]
    if canvas_clockwise:
        pts = pts[::-1]
    return {
        "closed": True,
        "vertices": [
            {"x": float(px), "y": float(py), "control_1": None, "control_2": None,
             "control_mode": "corner"}
            for px, py in pts
        ],
    }


# ── 1. UFO zip 读写 ───────────────────────────────────────────────────────

def test_rect_fixture_orientation():
    """自检 helper：逆时针矩形的面积为正、顺时针为负。"""
    font = _new_font()
    glyph = font.newGlyph("A")
    _draw_rect(glyph.getPointPen(), 0, 0, 100, 100)
    assert _areas(glyph)[0] == 10000

    font2 = _new_font()
    glyph2 = font2.newGlyph("B")
    _draw_rect(glyph2.getPointPen(), 0, 0, 100, 100, clockwise=True)
    assert _areas(glyph2)[0] == -10000


def _zip_bytes(entries):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in entries.items():
            z.writestr(name, data)
    return buf.getvalue()


def _glif_with_ref():
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<glyph name="B" format="2">\n'
        '  <advance width="600"/>\n'
        '  <outline>\n'
        '    <component base="A" xOffset="10" data-ref-name="A_Ref_1"/>\n'
        '  </outline>\n'
        '</glyph>\n'
    ).encode("utf-8")


def test_sanitize_glif_zip_strips_custom_attribute():
    data = _zip_bytes({
        "font.ufo/glyphs/B_.glif": _glif_with_ref(),
        "font.ufo/metainfo.plist": b"<plist>data-ref-name is not stripped here</plist>",
    })
    out = font_ops._sanitize_glif_zip(data)
    with zipfile.ZipFile(io.BytesIO(out)) as z:
        glif = z.read("font.ufo/glyphs/B_.glif").decode("utf-8")
        assert "data-ref-name" not in glif
        assert '<component base="A" xOffset="10"/>' in glif
        # 非 .glif 条目按原字节保留
        assert z.read("font.ufo/metainfo.plist") == b"<plist>data-ref-name is not stripped here</plist>"


def test_sanitize_glif_zip_returns_input_when_nothing_to_change():
    data = _zip_bytes({"font.ufo/glyphs/A_.glif": b'<glyph name="A" format="2"/>'})
    assert font_ops._sanitize_glif_zip(data) is data


def test_ufo_zip_roundtrip_preserves_geometry():
    font = _new_font()
    _draw_rect(font.newGlyph("A").getPointPen(), 10, 20, 300, 400)
    _draw_rect(font.newGlyph("B").getPointPen(), 0, 0, 100, 100)
    _draw_rect(font["B"].getPointPen(), 50, 50, 100, 100)

    blob = font_ops.dump_ufo_zip(font)
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        names = z.namelist()
    assert names, "dump 出的 zip 不能为空"
    assert all(n.startswith("font.ufo/") for n in names), names[:5]

    back = font_ops.load_ufo_zip(blob)
    assert sorted(back.keys()) == ["A", "B"]
    assert _areas(back["A"]) == [300 * 400]
    assert sorted(_areas(back["B"])) == sorted([10000, 10000])


# ── 2. correct direction ─────────────────────────────────────────────────

def test_correct_direction_fixes_outer_and_hole():
    font = _new_font()
    bad = font.newGlyph("A")
    _draw_rect(bad.getPointPen(), 0, 0, 400, 400, clockwise=True)   # 外层应逆时针
    _draw_rect(bad.getPointPen(), 100, 100, 200, 200)               # 内孔应顺时针
    good = font.newGlyph("B")
    _draw_rect(good.getPointPen(), 0, 0, 400, 400)                  # 已经正确
    _draw_rect(good.getPointPen(), 100, 100, 200, 200, clockwise=True)

    fixed = font_ops.correct_direction(font)

    assert fixed == 1, "只有 A 需要修正"
    outer, hole = _areas(font["A"])
    assert outer > 0 and hole < 0
    assert outer == 160000 and hole == -40000
    # 已正确的字形保持不变（点位未被重写）
    assert _areas(font["B"]) == [160000, -40000]


def test_correct_direction_skips_open_contours():
    font = _new_font()
    glyph = font.newGlyph("A")
    _draw_open(glyph.getPointPen(), [(0, 0), (100, 0), (100, 100)])
    before = [(p.x, p.y) for p in next(iter(glyph))]
    assert font_ops.correct_direction(font) == 0
    assert [(p.x, p.y) for p in next(iter(glyph))] == before


# ── 3. remove overlap ────────────────────────────────────────────────────

def test_remove_overlap_unions_overlapping_squares():
    font = _new_font()
    glyph = font.newGlyph("A")
    _draw_rect(glyph.getPointPen(), 0, 0, 100, 100)
    _draw_rect(glyph.getPointPen(), 50, 50, 100, 100)

    assert font_ops.remove_overlap(font) == 1

    areas = _areas(font["A"])
    assert len(areas) == 1, f"重叠应合并为一条轮廓，实际 {len(areas)}"
    assert abs(sum(areas) - (20000 - 2500)) < 1, areas


def test_remove_overlap_keeps_hole():
    """remove overlap 是「把重叠拍平」，不是 union 填洞。"""
    font = _new_font()
    glyph = font.newGlyph("A")
    _draw_rect(glyph.getPointPen(), 0, 0, 200, 200)
    _draw_rect(glyph.getPointPen(), 50, 50, 100, 100, clockwise=True)

    font_ops.remove_overlap(font)

    areas = _areas(font["A"])
    assert len(areas) == 2, f"内孔必须保留，实际 {areas}"
    assert abs(sum(areas) - (40000 - 10000)) < 1, areas
    assert max(areas) > 0 > min(areas), "外轮廓与内孔方向必须相反"


# ── 4. 导出 ──────────────────────────────────────────────────────────────

def _exportable_font():
    font = _new_font()
    font.newGlyph(".notdef")
    a = font.newGlyph("A")
    a.unicodes = [0x41]
    _draw_rect(a.getPointPen(), 0, 0, 400, 400, clockwise=True)  # 故意反向，导出应自行修正
    _draw_rect(a.getPointPen(), 100, 100, 200, 200)
    return font


def test_export_font_otf_and_ttf_are_valid_fonts():
    for fmt, table, magic in (("otf", "CFF ", b"OTTO"), ("ttf", "glyf", b"\x00\x01\x00\x00")):
        blob = font_ops.export_font(_exportable_font(), fmt)
        assert blob[:4] == magic, (fmt, blob[:4])
        parsed = TTFont(io.BytesIO(blob))
        assert table in parsed, f"{fmt} 缺少 {table.strip()} 表"
        assert "A" in parsed.getGlyphOrder()
        assert parsed["head"].unitsPerEm == 1000


def test_export_font_rejects_unknown_format():
    try:
        font_ops.export_font(_exportable_font(), "woff2")
    except ValueError as e:
        assert "woff2" in str(e)
    else:  # pragma: no cover
        raise AssertionError("不支持的格式必须抛 ValueError")


# ── 5. 路径级操作（前端选中路径接口）─────────────────────────────────────

def test_remove_overlap_paths_passes_open_paths_through():
    open_path = {
        "closed": False,
        "vertices": [
            {"x": 0.0, "y": 0.0, "control_1": None, "control_2": None, "control_mode": "corner"},
            {"x": 100.0, "y": 50.0, "control_1": None, "control_2": None, "control_mode": "corner"},
            {"x": 200.0, "y": 0.0, "control_1": None, "control_2": None, "control_mode": "corner"},
        ],
    }
    result = font_ops.remove_overlap_paths([open_path])
    assert len(result) == 1
    assert result[0]["closed"] is False
    assert result[0]["vertices"] == open_path["vertices"]


def test_remove_overlap_paths_unions_closed_paths():
    a = _square_path(0, 0, 100)
    b = _square_path(50, 50, 100)
    result = font_ops.remove_overlap_paths([a, b])

    assert len(result) == 1, f"重叠的两条闭合路径应合并，实际 {len(result)}"
    area = abs(_shoelace_canvas(result[0]["vertices"]))
    assert abs(area - (20000 - 2500)) < 1, area


def test_correct_direction_paths_gives_hole_opposite_winding():
    outer = _square_path(0, 0, 200)
    hole = _square_path(50, 50, 100)
    result = font_ops.correct_direction_paths([outer, hole])

    assert len(result) == 2
    a0 = _shoelace_canvas(result[0]["vertices"])
    a1 = _shoelace_canvas(result[1]["vertices"])
    assert abs(abs(a0) - 40000) < 1 and abs(abs(a1) - 10000) < 1, (a0, a1)
    assert (a0 > 0) != (a1 > 0), "外轮廓与内孔方向必须相反"
