"""InkShader 后端字体操作（fontTools 生态）。

- correct_direction —— 修正 UFO 字形轮廓方向（外轮廓逆时针、内孔顺时针，
  Y-up 坐标，PostScript 惯例——与 ufo2ft 导出的假设一致：TTF 导出时
  ufo2ft 会整体翻转所有轮廓，OTF/CFF 则原样使用）。
- remove_overlap   —— 移除字形轮廓重叠（先校正方向，再按字形做布尔并集；
  复合字形先分解再合并，失败的字形保持原样）。
- export_font      —— 用 ufo2ft 把 UFO 编译为 OTF（CFF）/ TTF（glyf）；
  编译前自动校正方向并移除重叠（对导出的副本，不改动源数据）。

输入/输出统一为 UFO ZIP（前端 JSZip 构建/解析），即「以 UFO 作为传输格式」。
"""
from __future__ import annotations

import io
import logging
import os
import re
import tempfile
import zipfile
from typing import List, Optional, Tuple

log = logging.getLogger("inkshader.font_ops")

try:
    import ufoLib2
except Exception:  # pragma: no cover
    ufoLib2 = None

# (x, y) 点
_Point = Tuple[float, float]
# 点轮廓：addPoint 5 元组 + 终结符（"close" / "end"）
_PointContour = List[object]


def _require_ufo():
    if ufoLib2 is None:  # pragma: no cover
        raise RuntimeError("ufoLib2 is not installed")


# ── UFO zip 读写 ──────────────────────────────────────────────────────────

_GLIF_CUSTOM_ATTR = re.compile(r'\s+data-ref-name="[^"]*"')


def _sanitize_glif_zip(data: bytes) -> bytes:
    """移除前端导出的自定义 GLIF 属性（data-ref-name），使 ufoLib2/glifLib 可读。

    前端把组件引用组的原始名字写入 <component data-ref-name=...> 以便前端
    UFO 往返还原引用名；glifLib 读入时不认识该属性会直接报错，这里在读取前
    从 .glif 条目中剥掉它。
    """
    changed = False
    out = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as zin:
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
            for info in zin.infolist():
                raw = zin.read(info.filename)
                if info.filename.endswith(".glif"):
                    text = raw.decode("utf-8", errors="replace")
                    new = _GLIF_CUSTOM_ATTR.sub("", text)
                    if new != text:
                        raw = new.encode("utf-8")
                        changed = True
                zout.writestr(info, raw)
    return out.getvalue() if changed else data


def load_ufo_zip(data: bytes):
    """从 UFO ZIP 字节读入 ufoLib2 Font。"""
    _require_ufo()
    data = _sanitize_glif_zip(data)
    fd, path = tempfile.mkstemp(suffix=".ufoz")
    os.close(fd)
    os.unlink(path)  # mkstemp 会创建文件，ufoLib2 要求目标不存在
    try:
        with open(path, "wb") as f:
            f.write(data)
        return ufoLib2.Font.open(path)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def dump_ufo_zip(font) -> bytes:
    """把 ufoLib2 Font 存为 UFO ZIP 字节。

    zip 内顶层目录名取输出文件名：存为 font.ufoz => 顶层为 font.ufo/，
    与前端 JSZip 的解析约定（font.ufo/fontinfo.plist）一致。
    """
    _require_ufo()
    tmpdir = tempfile.mkdtemp(prefix="inkshader_ufo_")
    path = os.path.join(tmpdir, "font.ufoz")
    try:
        font.save(path, structure="zip")
        with open(path, "rb") as f:
            return f.read()
    finally:
        try:
            for root, _dirs, files in os.walk(tmpdir):
                for name in files:
                    try:
                        os.unlink(os.path.join(root, name))
                    except OSError:
                        pass
            os.rmdir(tmpdir)
        except OSError:
            pass


# ── correct direction ─────────────────────────────────────────────────────

def _splitPointGlyph(recorded):
    """把 RecordingPointPen 记录（(op, args, kwargs) 列表）拆成点轮廓 + 组件。

    每个轮廓 = [ (pt, segmentType, smooth, name[, identifier]) ...,
                "close" | "end" ]
    """
    contours: List[_PointContour] = []
    components = []
    cur: Optional[_PointContour] = None
    for op, args, _kwargs in recorded:
        if op == "beginPath":
            cur = []
            contours.append(cur)
        elif op == "addPoint":
            if cur is not None:
                cur.append(args)  # (pt, segmentType, smooth, name[, identifier])
        elif op == "closePath":
            if cur is not None:
                cur.append("close")
        elif op == "endPath":
            if cur is not None:
                cur.append("end")
        elif op == "addComponent":
            components.append(args)  # (glyphName, transform)
    return contours, components


def _recordPointGlyph(glyph):
    """录制字形的点记录（用于 _splitPointGlyph）。"""
    from fontTools.pens.recordingPen import RecordingPointPen

    rec = RecordingPointPen()
    glyph.drawPoints(rec)
    return rec.value


def _isClosed(pts: _PointContour) -> bool:
    """轮廓是否闭合：首个 on-curve 点的类型不是 "move" 即闭合。"""
    for item in pts[:-1]:
        seg_type = item[1]
        if seg_type is not None:
            return seg_type != "move"
    return True  # 全 off-curve：按闭合处理


def _pointContourToSegmentOps(pts: _PointContour):
    """点轮廓 -> 线段 op 列表（供 AreaPen / 翻转 / 展平使用）。"""
    from fontTools.pens.pointPen import PointToSegmentPen
    from fontTools.pens.recordingPen import RecordingPen

    rec = RecordingPen()
    stp = PointToSegmentPen(rec)
    stp.beginPath()
    for item in pts[:-1]:
        # addPoint args: (pt, segmentType, smooth, name[, identifier])
        pt, seg_type, smooth = item[0], item[1], item[2]
        name = item[3] if len(item) > 3 else None
        stp.addPoint(pt, seg_type, smooth, name)
    # PointToSegmentPen.endPath 依据首点类型自动判定闭合
    stp.endPath()
    return rec.value


def _contourArea(pts: _PointContour) -> Optional[float]:
    """轮廓的精确有向面积（Y-up：逆时针为正）。开放轮廓返回 None。"""
    from fontTools.pens.areaPen import AreaPen

    if not _isClosed(pts):
        return None
    pen = AreaPen()
    try:
        for op, args in _pointContourToSegmentOps(pts):
            getattr(pen, op)(*args)
    except Exception:
        return None
    return pen.value


def _flattenContour(pts: _PointContour, per_curve: int = 16) -> List[_Point]:
    """把轮廓展平为线段列表 [(p0, p1), ...]（用于点包含测试）。"""
    from fontTools.pens.recordingPen import RecordingPen
    from fontTools.pens.pointPen import PointToSegmentPen

    rec = RecordingPen()
    stp = PointToSegmentPen(rec)
    stp.beginPath()
    for item in pts[:-1]:
        # addPoint args: (pt, segmentType, smooth, name[, identifier])
        pt, seg_type, smooth = item[0], item[1], item[2]
        name = item[3] if len(item) > 3 else None
        stp.addPoint(pt, seg_type, smooth, name)
    # PointToSegmentPen.endPath 依据首点类型自动判定闭合
    stp.endPath()

    segs: List[Tuple[_Point, _Point]] = []
    prev: Optional[_Point] = None
    start: Optional[_Point] = None
    for op, args in rec.value:
        if op == "moveTo":
            start = prev = args[0]
        elif op == "lineTo":
            segs.append((prev, args[0]))
            prev = args[0]
        elif op == "curveTo":
            p0, p1, p2, p3 = prev, args[0], args[1], args[2]
            a, b, c, d = p0, p1, p2, p3
            for i in range(1, per_curve + 1):
                t = i / per_curve
                mt = 1 - t
                x = (mt ** 3) * a[0] + 3 * (mt ** 2) * t * b[0] + 3 * mt * (t ** 2) * c[0] + (t ** 3) * d[0]
                y = (mt ** 3) * a[1] + 3 * (mt ** 2) * t * b[1] + 3 * mt * (t ** 2) * c[1] + (t ** 3) * d[1]
                segs.append((prev, (x, y)))
                prev = (x, y)
        elif op == "qCurveTo":
            # 二次 -> 三次等价
            p0, p1, p2 = prev, args[0], args[1] if len(args) > 1 else None
            if p2 is None:  # 单点 qCurve：实际上是直线/退化
                segs.append((prev, p1))
                prev = p1
                continue
            a, b, c = p0, p1, p2
            for i in range(1, per_curve + 1):
                t = i / per_curve
                mt = 1 - t
                x = (mt ** 2) * a[0] + 2 * mt * t * b[0] + (t ** 2) * c[0]
                y = (mt ** 2) * a[1] + 2 * mt * t * b[1] + (t ** 2) * c[1]
                segs.append((prev, (x, y)))
                prev = (x, y)
        elif op == "closePath":
            if start is not None and prev != start:
                segs.append((prev, start))
            prev = start
    return segs


_EPS = 1e-7


def _pointOnSegment(pt: _Point, a: _Point, b: _Point) -> bool:
    """点是否落在线段上（含端点）。"""
    x, y = pt
    x0, y0 = a
    x1, y1 = b
    cross = (x - x0) * (y1 - y0) - (y - y0) * (x1 - x0)
    if abs(cross) > _EPS * (abs(x1 - x0) + abs(y1 - y0) + 1e-9):
        return False
    return (
        min(x0, x1) - _EPS <= x <= max(x0, x1) + _EPS
        and min(y0, y1) - _EPS <= y <= max(y0, y1) + _EPS
    )


def _pointStrictlyInContour(pt: _Point, segs: List[Tuple[_Point, _Point]]) -> bool:
    """奇偶射线法（向右水平射线）。落在边界上视为不在内部。"""
    x, y = pt
    for a, b in segs:
        if _pointOnSegment(pt, a, b):
            return False  # 在边界上：不严格在内部
    inside = False
    for (x0, y0), (x1, y1) in segs:
        if (y0 > y) != (y1 > y):
            xint = x0 + (x1 - x0) * (y - y0) / (y1 - y0)
            if xint > x:
                inside = not inside
    return inside


def _contourSamplePoints(pts: _PointContour) -> List[_Point]:
    """轮廓采样点：所有 on-curve 点（用于嵌套判定）。

    注意不能用质心：当轮廓是外轮廓时质心可能落在内孔里，导致嵌套深度误判。
    用全部 on-curve 点并要求「全部严格在对方内部」判定包含关系，可容忍
    轮廓共享边（重合边）的退化情形。
    """
    return [item[0] for item in pts[:-1] if item[1] is not None]


def _reversePointContour(pts: _PointContour) -> _PointContour:
    """点空间反转：倒序 + 旋转到 on-curve 点开头，并重映射 on-curve 类型。

    GLIF 中 on-curve 点的 type 描述「以此点结束的线段」：line（无控制点）/
    curve（2 个控制点）/ qcurve（1 个控制点）。反转后，原线段的方向翻转，
    因此每个 on-curve 点的类型必须改为「原轮廓中以它开始的线段」的类型
    （= 反转后以它结束的线段类型），否则会出现 offcurve 紧邻 line 的非法结构。
    """
    body = pts[:-1]
    term = pts[-1]
    n = len(body)
    if n == 0:
        return pts
    # 原轮廓中每个 on-curve 点之后（到下一个 on-curve 前）的 offcurve 数量
    on_indices = [k for k, it in enumerate(body) if it[1] is not None]
    new_type = {}  # 原索引 -> 反转后的类型
    if len(on_indices) == 1:
        # 只有一个 on-curve：无法确定线段类型，保持原类型
        pass
    else:
        for idx, k in enumerate(on_indices):
            nxt = on_indices[(idx + 1) % len(on_indices)]
            off_count = 0
            j = (k + 1) % n
            while j != nxt:
                if body[j][1] is None:
                    off_count += 1
                j = (j + 1) % n
            new_type[k] = "line" if off_count == 0 else ("qcurve" if off_count == 1 else "curve")

    rev = []
    for r in range(n):
        orig = n - 1 - r
        item = body[orig]
        if item[1] is not None and orig in new_type:
            # addPoint args: (pt, segmentType, smooth, name[, identifier])
            item = (item[0], new_type[orig], item[2],) + tuple(item[3:])
        rev.append(item)
    # 旋转到 on-curve 点开头
    idx = 0
    for i, item in enumerate(rev):
        if item[1] is not None:
            idx = i
            break
    rev = rev[idx:] + rev[:idx]
    return rev + [term]


def _normalizeTransform(transform):
    """把 (序列 | Transform | xScale 风格 dict) 归一化为 fontTools Transform。"""
    from fontTools.misc.transform import Transform

    if isinstance(transform, Transform):
        return transform
    if isinstance(transform, (tuple, list)):
        return Transform(*transform)
    # dict：{'xScale','xyScale','yxScale','yScale','xOffset','yOffset'}
    return Transform(
        transform.get("xScale", 1), transform.get("xyScale", 0),
        transform.get("yxScale", 0), transform.get("yScale", 1),
        transform.get("xOffset", 0), transform.get("yOffset", 0),
    )


def _writePointGlyph(glyph, contours, components):
    """用点笔写回字形（先组件后轮廓）。"""
    glyph.clearContours()
    glyph.clearComponents()
    pp = glyph.getPointPen()
    for name, transform in components:
        pp.addComponent(name, _normalizeTransform(transform))
    for pts in contours:
        pp.beginPath()
        for item in pts[:-1]:
            # addPoint args: (pt, segmentType, smooth, name[, identifier])
            pt, seg_type, smooth = item[0], item[1], item[2]
            name = item[3] if len(item) > 3 else None
            identifier = item[4] if len(item) > 4 else None
            pp.addPoint(pt, seg_type, smooth, name, identifier)
        # 点笔无 closePath：闭合性由首点类型（move / 其他）决定
        pp.endPath()


def _contourNestingDepths(contours):
    """计算每个闭合轮廓的嵌套深度（被多少个闭合轮廓包含）。开放轮廓深度为 None。"""
    areas = [_contourArea(c) for c in contours]
    flattened = [_flattenContour(c) if _isClosed(c) else None for c in contours]
    samples = [_contourSamplePoints(c) for c in contours]
    depths = []
    for i, c in enumerate(contours):
        if not _isClosed(c) or areas[i] is None or not samples[i]:
            depths.append(None)
            continue
        depth = 0
        for j, cj in enumerate(contours):
            if j == i or not _isClosed(cj) or flattened[j] is None:
                continue
            # 全部采样点都严格在 j 内部 => i 包含于 j
            if all(_pointStrictlyInContour(p, flattened[j]) for p in samples[i]):
                depth += 1
        depths.append(depth)
    return areas, depths


def _flipWrongContours(contours):
    """就地翻转方向错误的闭合轮廓，返回每条的翻转标记。

    约定（Y-up，PostScript）：偶数层（外轮廓）逆时针（面积>0），
    奇数层（内孔）顺时针（面积<0）。ufo2ft 导出 TTF 时会整体翻转轮廓、
    OTF 原样使用，源 UFO 必须保持 PostScript 约定两个导出才都正确。
    开放轮廓跳过（方向无定义）。
    """
    areas, depths = _contourNestingDepths(contours)
    flipped = []
    for i, c in enumerate(contours):
        if not _isClosed(c) or areas[i] is None or depths[i] is None:
            flipped.append(False)
            continue
        # 偶数层（外）应为逆时针（面积>0）；奇数层（孔）应为顺时针（面积<0）
        expected_positive = (depths[i] % 2) == 0
        wrong = (areas[i] < 0) if expected_positive else (areas[i] > 0)
        if wrong:
            contours[i] = _reversePointContour(c)
            flipped.append(True)
        else:
            flipped.append(False)
    return flipped


def correct_direction(font) -> int:
    """修正字形轮廓方向。返回修正过的字形数。

    约定（Y-up，PostScript）：偶数层（外轮廓）逆时针（面积>0），
    奇数层（内孔）顺时针（面积<0）。
    组件字形跳过（方向由基字形决定）；开放轮廓跳过（方向无定义）。
    """
    _require_ufo()
    fixed = 0
    for name in list(font.keys()):
        glyph = font[name]
        if not glyph.contours:
            continue  # 纯组件字形：方向跟随基字形
        contours, components = _splitPointGlyph(_recordPointGlyph(glyph))
        if not contours:
            continue
        flipped = _flipWrongContours(contours)
        if any(flipped):
            _writePointGlyph(glyph, contours, components)
            fixed += 1
    return fixed


# ── remove overlap ────────────────────────────────────────────────────────

class _ContourOperand:
    """booleanOperations 的操作数适配器：单轮廓，drawPoints + len(点数)。"""

    __slots__ = ("_items", "_npoints")

    def __init__(self, items):
        self._items = items  # addPoint 参数列表（不含终结符）
        self._npoints = sum(1 for it in items if it[1] is not None)

    def drawPoints(self, pointPen):
        pointPen.beginPath()
        for it in self._items:
            pt, seg_type, smooth = it[0], it[1], it[2]
            name = it[3] if len(it) > 3 else None
            pointPen.addPoint(pt, seg_type, smooth, name)
        pointPen.endPath()

    def __len__(self):
        return self._npoints


def _unionContours(contours):
    """对一组点轮廓做布尔并集，返回结果轮廓列表。输入应先校正方向。"""
    from booleanOperations import union
    from fontTools.pens.recordingPen import RecordingPointPen

    operands = [
        _ContourOperand(pts[:-1]) for pts in contours if len(pts) > 1
    ]
    if not operands:
        return []
    out = RecordingPointPen()
    union(operands, out)
    result_contours, _comps = _splitPointGlyph(out.value)
    return result_contours


def remove_overlap(font) -> int:
    """移除字形重叠轮廓。返回处理过的字形数。

    流程：先 correct_direction（布尔并集依赖轮廓方向区分内外），
    再逐字形分解组件、把每个轮廓作为独立操作数做布尔并集。
    失败的字形保持原样。
    """
    _require_ufo()
    try:
        correct_direction(font)
    except Exception as e:  # noqa: BLE001
        log.warning("correct_direction pre-pass failed: %s", e)

    from fontTools.pens.recordingPen import DecomposingRecordingPointPen

    glyph_set = font.layers.defaultLayer
    processed = 0
    for name in list(font.keys()):
        glyph = font[name]
        if not glyph.contours:
            continue
        try:
            rec = DecomposingRecordingPointPen(glyph_set)
            glyph.drawPoints(rec)
            contours, _components = _splitPointGlyph(rec.value)
            if not contours:
                continue
            result = _unionContours(contours)
            if not result:
                continue
            glyph.clearContours()
            glyph.clearComponents()
            pp = glyph.getPointPen()
            for pts in result:
                pp.beginPath()
                for item in pts[:-1]:
                    # addPoint args: (pt, segmentType, smooth, name[, identifier])
                    pt, seg_type, smooth = item[0], item[1], item[2]
                    name = item[3] if len(item) > 3 else None
                    identifier = item[4] if len(item) > 4 else None
                    pp.addPoint(pt, seg_type, smooth, name, identifier)
                pp.endPath()  # ufoLib2 点笔：endPath 才把轮廓提交到字形
            processed += 1
        except Exception as e:  # noqa: BLE001
            log.debug("remove overlap skipped %s: %s", name, e)
    # pyclipper 输出的方向约定不一致，最后统一校正一次方向
    try:
        correct_direction(font)
    except Exception as e:  # noqa: BLE001
        log.warning("final correct_direction failed: %s", e)
    return processed


# ── 选中路径级操作（逐条处理，不做整文件往返）──────────────────────────────
#
# 与字形级操作共享同一套几何算法，但作用域是「前端选中的路径列表」：
# 前端把每条路径的顶点（画布 Y-down 坐标）序列化发送，后端 Y-flip 到
# 字体坐标空间处理后再翻回，只返回这些路径的结果，绝不动文件里的其他内容。
# 前端拿到结果后原位应用并以历史命令提交（可撤销）。

# 顶点：{"x","y","control_1": {"x","y"}|null, "control_2": {"x","y"}|null,
#        "control_mode": "corner"|"smooth"|"symmetric"}
# 路径：{"closed": bool, "vertices": [顶点...]}
# control_1 = 出向控制柄（指向下一个顶点），control_2 = 入向控制柄（来自上一个顶点）。


def _handle_yup(h):
    """控制柄 dict（画布 Y-down）-> (x, y)（字体坐标空间 Y-up）；None 原样。"""
    if not isinstance(h, dict):
        return None
    return (float(h["x"]), -float(h["y"]))


def _pathToPointContour(path):
    """路径 JSON（画布 Y-down）-> 点轮廓（Y-flip 到字体坐标空间）。

    闭合路径：首点类型 = 闭合段（末点 -> 首点）的类型（curve/line）；
    闭合段的控制点排在点列表末尾（出向控制柄在前、入向在后），与 GLIF 约定一致。
    """
    verts = path.get("vertices") or []
    closed = bool(path.get("closed"))
    pts = []
    # 闭合段（末点 -> 首点）：出向 = 末点 control_1，入向 = 首点 control_2
    close_out = _handle_yup(verts[-1].get("control_1")) if closed and verts else None
    close_in = _handle_yup(verts[0].get("control_2")) if closed and verts else None
    for i, v in enumerate(verts):
        x, y = float(v.get("x", 0)), -float(v.get("y", 0))
        smooth = v.get("control_mode") in ("smooth", "symmetric")
        if i == 0:
            # 首点类型 = 闭合段（末点 -> 首点）的类型：有控制柄为 curve，否则 line；
            # 开放路径首点为 move。闭合段的控制点排在点列表末尾（GLIF 约定）。
            seg_type = "move"
            if closed:
                seg_type = "curve" if (close_out is not None or close_in is not None) else "line"
            pts.append(((x, y), seg_type, smooth or None, None))
            continue
        prev = verts[i - 1]
        out = _handle_yup(prev.get("control_1"))
        inn = _handle_yup(v.get("control_2"))
        if out is not None and inn is not None:
            pts.append((out, None, None, None))
            pts.append((inn, None, None, None))
            pts.append(((x, y), "curve", smooth or None, None))
        elif out is not None or inn is not None:
            # 单控制柄 = 二次曲线（qcurve）。pyclipper/booleanOperations 不支持
            # qcurve，精确转成等价三次曲线：C1 = P0 + 2/3(Q-P0), C2 = P1 + 2/3(Q-P1)
            q = out if out is not None else inn
            p0 = (float(prev.get("x", 0)), -float(prev.get("y", 0)))
            p1 = (x, y)
            c1 = (p0[0] + (q[0] - p0[0]) * 2 / 3, p0[1] + (q[1] - p0[1]) * 2 / 3)
            c2 = (p1[0] + (q[0] - p1[0]) * 2 / 3, p1[1] + (q[1] - p1[1]) * 2 / 3)
            pts.append((c1, None, None, None))
            pts.append((c2, None, None, None))
            pts.append(((x, y), "curve", smooth or None, None))
        else:
            pts.append(((x, y), "line", smooth or None, None))
    if closed:
        # 闭合段控制点排在列表末尾：末点出向 + 首点入向（与中间段顺序一致：出向在前）
        if close_out is not None and close_in is not None:
            pts.append((close_out, None, None, None))
            pts.append((close_in, None, None, None))
        elif close_out is not None or close_in is not None:
            # 闭合段 qcurve -> 等价三次
            q = close_out if close_out is not None else close_in
            p0 = (float(verts[-1].get("x", 0)), -float(verts[-1].get("y", 0)))
            p1 = (float(verts[0].get("x", 0)), -float(verts[0].get("y", 0)))
            c1 = (p0[0] + (q[0] - p0[0]) * 2 / 3, p0[1] + (q[1] - p0[1]) * 2 / 3)
            c2 = (p1[0] + (q[0] - p1[0]) * 2 / 3, p1[1] + (q[1] - p1[1]) * 2 / 3)
            pts.append((c1, None, None, None))
            pts.append((c2, None, None, None))
        pts.append("close")
    else:
        pts.append("end")
    return pts


def _pointContourToPath(pts, closed):
    """点轮廓（字体坐标空间 Y-up）-> 路径 JSON（画布 Y-down）。"""
    body = pts[:-1]
    on_indices = [k for k, it in enumerate(body) if it[1] is not None]
    n = len(on_indices)
    if n == 0:
        return []
    # seg_offs[i] = 第 i 个 on-curve 之后、下一个 on-curve 之前的 offcurve 列表
    seg_offs = []
    for i in range(n):
        k = on_indices[i]
        nxt = on_indices[(i + 1) % n] if n > 1 else k
        offs = []
        j = (k + 1) % len(body)
        while j != nxt:
            if body[j][1] is None:
                offs.append(body[j][0])
            j = (j + 1) % len(body)
        seg_offs.append(offs)
    verts = []
    for i in range(n):
        k = on_indices[i]
        pt, _seg_type, smooth = body[k][0], body[k][1], body[k][2]
        seg_cur = seg_offs[i]            # 段：本点 -> 下一点
        seg_prev = seg_offs[(i - 1) % n]  # 段：上一点 -> 本点
        out = seg_cur[0] if len(seg_cur) >= 1 else None
        inn = seg_prev[-1] if len(seg_prev) >= 2 else None
        verts.append({
            "x": pt[0],
            "y": -pt[1],
            "control_1": {"x": out[0], "y": -out[1]} if out else None,
            "control_2": {"x": inn[0], "y": -inn[1]} if inn else None,
            "control_mode": "smooth" if smooth else "corner",
        })
    return verts


def correct_direction_paths(paths):
    """对选中的路径列表逐条校正方向。

    嵌套深度只在「本次选中的闭合路径」之间计算（选中集作为一个整体），
    每条返回 {"closed", "vertices", "reversed"}，reversed 表示是否翻转。
    """
    contours = [_pathToPointContour(p) for p in paths]
    # _flipWrongContours 就地翻转，contours[i] 即校正后的轮廓；
    # 这里若再按 reversed 反转一次，返回的顶点会被转回原样，与 reversed 标记矛盾。
    flipped = _flipWrongContours(contours)
    results = []
    for contour, fl, path in zip(contours, flipped, paths):
        closed = bool(path.get("closed"))
        results.append({
            "closed": closed,
            "vertices": _pointContourToPath(contour, closed),
            "reversed": fl,
        })
    return results


def remove_overlap_paths(paths):
    """对选中的闭合路径做布尔并集（移除重叠），返回结果轮廓路径。

    开放路径不参与并集（方向/填充语义未定义），原样返回。
    流程：先校正方向，再并集，最后再校正一次输出方向。
    """
    contours = [_pathToPointContour(p) for p in paths]
    try:
        _flipWrongContours(contours)
    except Exception as e:  # noqa: BLE001
        log.warning("remove_overlap_paths pre-pass failed: %s", e)

    closed_contours = [c for c in contours if _isClosed(c)]
    open_paths = [p for p, c in zip(paths, contours) if not _isClosed(c)]

    result = []
    if closed_contours:
        try:
            out_contours = _unionContours(closed_contours)
            try:
                _flipWrongContours(out_contours)
            except Exception as e:  # noqa: BLE001
                log.warning("remove_overlap_paths final direction failed: %s", e)
            for c in out_contours:
                result.append({"closed": True, "vertices": _pointContourToPath(c, True)})
        except Exception as e:  # noqa: BLE001
            log.warning("remove_overlap_paths union failed: %s", e)
            # 并集失败：闭合路径原样保留
            for p, c in zip(paths, contours):
                if _isClosed(c):
                    result.append({"closed": True, "vertices": _pointContourToPath(c, True)})
    # 开放路径原样返回
    for p in open_paths:
        result.append({"closed": p.get("closed", False), "vertices": p.get("vertices", [])})
    return result


# ── export ────────────────────────────────────────────────────────────────

def export_font(font, fmt: str) -> bytes:
    """用 ufo2ft 把 UFO 编译为 OTF / TTF 字节。

    编译前在传入的 font 副本上自动：
    1. 校正方向（PostScript 约定——TTF/OTF 两个格式导出的必要前提）；
    2. 移除重叠（逐字形容错，失败的字形保持原样）。
    不修改磁盘上的源项目数据（font 是前端上传的传输副本）。
    """
    if fmt not in ("otf", "ttf"):
        raise ValueError(f"unsupported format: {fmt}")
    try:
        import ufo2ft
    except Exception:  # pragma: no cover
        raise RuntimeError("ufo2ft is not installed")
    try:
        correct_direction(font)
    except Exception as e:  # noqa: BLE001
        log.warning("export pre-pass correct_direction failed: %s", e)
    try:
        remove_overlap(font)
    except Exception as e:  # noqa: BLE001
        log.warning("export pre-pass remove_overlap failed: %s", e)
    fd, path = tempfile.mkstemp(suffix="." + fmt)
    os.close(fd)
    os.unlink(path)  # mkstemp 会创建文件，编译目标要求不存在
    try:
        if fmt == "otf":
            result = ufo2ft.compileOTF(font)
        else:
            result = ufo2ft.compileTTF(font)
        result.save(path)
        with open(path, "rb") as f:
            return f.read()
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass