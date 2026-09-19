/**
 * Curve Canvas rendering: reads domain geometry, applies theme and viewport, calls Canvas API.
 */
import { getCanvasTheme } from "./canvas_theme.js";
import {
    emitBooleanSubpaths,
    emitCubicBezierSegments,
    emitExpandedStrokeOutline,
    booleanViewportDOMMatrix,
    buildBooleanPath2D
} from "../../core/bezier/path_emitter.js";
import { createViewportTransform } from "./viewport_transform.js";
import { getPaperScope } from "../../core/paper_scope.js";

export function isCurveStrokePreview(canvas, curveId, refId = null) {
    return !!canvas?.isCurveInInteractiveStrokePreview?.(curveId, refId ?? null);
}

/**
 * True while a pointer gesture is actively changing geometry (node drag, object
 * transform, painting, box select, pan).
 *
 * Why this matters for smart strokes: the boolean (expand) cache is validated by
 * a geometry hash, and a drag changes that hash every single frame. Rebuilding
 * the cache therefore means running the full Paper.js boolean N times per second
 * on geometry that is about to change again — pure waste, and the reason a drag
 * on a smart-stroke object stutters while the same object with smart stroke
 * switched OFF is perfectly smooth (a plain stroke never touches the boolean).
 * Rebuilds are only allowed outside gestures; the caches are flushed/refreshed
 * once when the gesture ends (see CanvasHandler.flushSmartStrokeBooleanCache).
 */
export function isGeometryGestureActive(canvas) {
    if (!canvas) return false;
    const state = canvas.current_state;
    if (state && state !== "IDLE") return true;
    return !!(canvas.transform_action || canvas.transform_started_moving
        || canvas.is_box_selecting || canvas.is_measuring);
}

/** Boolean cache usable (empty array [] = not cached, must fall back to expanded stroke path) */
export function hasUsableBooleanCache(curve) {
    return Array.isArray(curve?.cached_boolean_geometry) && curve.cached_boolean_geometry.length > 0;
}

export function curveGeneratesFillArea(curve) {
    if (!curve?.startNode) return false;
    if (curve.smart_stroke) {
        return curve.closed && curve.startNode !== curve.endNode || curve.stroke_width > 0;
    }
    return curve.closed && curve.startNode !== curve.endNode;
}

export function isCurveClosedRing(curve) {
    return !!(curve?.closed && curve.startNode && curve.endNode && curve.startNode !== curve.endNode);
}

/**
 * Whether to enter the "batch-fill by group" pass.
 * Interactive preview uses skeleton only — fill closed rings; open paths are stroked later.
 */
export function shouldBatchFillCurve(curve, { strokePreview = false } = {}) {
    if (!curveGeneratesFillArea(curve)) return false;
    if (strokePreview) {
        return isCurveClosedRing(curve);
    }
    return true;
}

/** Whether to use only center skeleton for batch fill (skips boolean/expand); smart-stroke preview does not use this branch */
export function usePreviewSkeletonForBatchFill(curve, { strokePreview = false } = {}) {
    if (!strokePreview || (curve.smart_stroke && curve.stroke_width > 0)) return false;
    return isCurveClosedRing(curve);
}

/** True when smart fill can use cached Path2D + CTM (skips per-frame bezier emit). */
export function canFillSmartStrokeWithPath2D(curve, { strokePreview = false, allowRebuild = true } = {}) {
    if (strokePreview) return false;
    if (!curve?.smart_stroke || curve.stroke_width <= 0) return false;
    if (!allowRebuild && curve._booleanContentHash !== curve.getGeometryHash()) return false;
    ensureBooleanCache(curve, { allowRebuild });
    if (!hasUsableBooleanCache(curve)) return false;
    if (!curve._booleanPath2D) {
        curve._booleanPath2D = buildBooleanPath2D(curve.cached_boolean_geometry);
    }
    return !!curve._booleanPath2D;
}

/** Fill smart-stroke using model-space Path2D (same geometry as emitBooleanSubpaths). */
export function fillSmartStrokePath2D(ctx, curve, viewport, fillStyle) {
    if (!ctx || !curve?._booleanPath2D) return false;
    const m = booleanViewportDOMMatrix(viewport);
    ctx.save();
    ctx.fillStyle = fillStyle;
    ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
    ctx.fill(curve._booleanPath2D, "nonzero");
    ctx.restore();
    return true;
}

/** Local recorder with the same interface as the path emitter expects. */
class OutlineRecorder {
    constructor() {
        this.paths = [];
        this.curr = null;
    }
    moveTo(x, y) { this.curr = []; this.paths.push(this.curr); this.curr.push({ t: "M", x, y }); }
    lineTo(x, y) { if (this.curr) this.curr.push({ t: "L", x, y }); }
    bezierCurveTo(a, b, c, d, e, f) { if (this.curr) this.curr.push({ t: "C", a, b, c, d, e, f }); }
    closePath() { if (this.curr) this.curr.push({ t: "Z" }); }
}

/** Signed area of the closed skeleton ring, in model space (0 when there is none). */
function skeletonRingSign(curve, pScope) {
    if (!curve?.startNode) return 0;
    const segs = curve.getSkeletonBezierSegments();
    if (!segs || segs.length < 2) return 0;
    const p = new pScope.Path();
    p.moveTo(new pScope.Point(segs[0].p0.x, segs[0].p0.y));
    for (const s of segs) {
        p.cubicCurveTo(
            new pScope.Point(s.p1.x, s.p1.y),
            new pScope.Point(s.p2.x, s.p2.y),
            new pScope.Point(s.p3.x, s.p3.y)
        );
    }
    p.closed = true;
    const sign = Math.sign(p.area || 0);
    p.remove();
    return sign;
}

/**
 * The expanded stroke band of a CLOSED smart path, with every band ring oriented
 * like the skeleton ring, as emitter-ready subpaths.
 *
 * Why the orientation matters: the fallback below paints the band and the
 * skeleton ring into the same nonzero fill, so a band ring wound against the
 * skeleton SUBTRACTS from the fill instead of adding to it. Measured on the
 * self-intersecting figure-eight in example/bug_test.json: the raw band pulled
 * 7.4% of the filled region (a whole lobe) out of the fallback — 97,981 instead
 * of the cached 105,852 — so the object painted one region while a gesture was
 * running and a different one once the cache was rebuilt. Aligning each band
 * ring with the skeleton's sign makes the fallback reproduce the cached region
 * (105,684 vs 105,852, i.e. inside rasterisation noise) without any boolean.
 *
 * The result is memoised per geometry hash so a drag does not rebuild it every
 * frame; the boolean cache is the expensive thing being avoided here, not this.
 */
function cheapBandSubpaths(curve, { roundCap, halfWidth }) {
    const hash = curve.getGeometryHash();
    const memo = curve._cheapBandSubpaths;
    if (memo && memo.hash === hash) return memo.subpaths;

    const pScope = getPaperScope();
    if (!pScope) return null;

    const rec = new OutlineRecorder();
    const outline = curve.computeExpandedStrokeOutline(halfWidth);
    if (!outline) return null;
    emitExpandedStrokeOutline(rec, outline, (x, y) => ({ x, y }), {
        roundCap,
        curve: roundCap ? curve : null,
        halfWidth: roundCap ? halfWidth : 0
    });

    const sign = skeletonRingSign(curve, pScope);
    const subpaths = [];
    for (const sub of rec.paths) {
        if (!sub.length) continue;
        const p = new pScope.Path();
        for (const cmd of sub) {
            if (cmd.t === "M") p.moveTo(new pScope.Point(cmd.x, cmd.y));
            else if (cmd.t === "L") p.lineTo(new pScope.Point(cmd.x, cmd.y));
            else if (cmd.t === "C") p.cubicCurveTo(new pScope.Point(cmd.a, cmd.b), new pScope.Point(cmd.c, cmd.d), new pScope.Point(cmd.e, cmd.f));
            else if (cmd.t === "Z") p.closed = true;
        }
        if (p.segments.length < 2) { p.remove(); continue; }
        if (sign !== 0 && Math.sign(p.area || 0) !== 0 && Math.sign(p.area || 0) !== sign) {
            try { p.reverse(); } catch (_) { /* keep the drawn orientation */ }
        }
        subpaths.push({
            closed: p.closed,
            segments: p.segments.map(seg => ({
                x: seg.point.x,
                y: seg.point.y,
                inX: seg.handleIn.x,
                inY: seg.handleIn.y,
                outX: seg.handleOut.x,
                outY: seg.handleOut.y
            }))
        });
        p.remove();
    }
    curve._cheapBandSubpaths = { hash, subpaths };
    return subpaths;
}

function appendSmartStrokeOutline(ctx, curve, mapPoint, { allowBooleanCache = true, allowRebuild = true } = {}) {
    if (!curve?.smart_stroke || curve.stroke_width <= 0) return false;
    const halfWidth = curve.stroke_width / 2;

    if (allowBooleanCache) {
        ensureBooleanCache(curve, { allowRebuild });
        if (hasUsableBooleanCache(curve) && (allowRebuild || curve._booleanContentHash === curve.getGeometryHash())) {
            if (!curve._booleanPath2D) {
                curve._booleanPath2D = buildBooleanPath2D(curve.cached_boolean_geometry);
            }
            emitBooleanSubpaths(ctx, curve.cached_boolean_geometry, mapPoint);
            return true;
        }
    }

    const roundCap = !curve.closed && curve._expandRoundCap === true;
    const closedRing = isCurveClosedRing(curve);
    if (closedRing) {
        // Closed ring: the skeleton is filled together with the band, so the band
        // must not wind against it (see cheapBandSubpaths).
        const subpaths = cheapBandSubpaths(curve, { roundCap, halfWidth });
        if (!subpaths) return false;
        emitBooleanSubpaths(ctx, subpaths, mapPoint);
        emitCubicBezierSegments(ctx, curve.getSkeletonBezierSegments(), mapPoint, { close: true });
        return true;
    }
    const outline = curve.computeExpandedStrokeOutline(halfWidth);
    if (!outline) return false;
    emitExpandedStrokeOutline(ctx, outline, mapPoint, {
        roundCap,
        curve: roundCap ? curve : null,
        halfWidth: roundCap ? halfWidth : 0
    });
    // 廉价 expand 只给出「描边带」，而闭合路径的填充区（内圈）在布尔缓存里是
    // 一个独立的环。于是手势期间（重建被推迟 → 只能用这条廉价路径）画闭合
    // smart 路径会只剩描边带，填充整个消失——即「拖动新节点时总是没有填充」：
    // 用钢笔按住拖动的时候 current_state 一直是 PAINTING_HANDLE，
    // allowRebuild=false，松手回到 IDLE 才重建缓存，填充就「突然出现」。
    //
    // 修法：把骨架环一并放进填充路径。填充区 ∪ 描边带 恰好就是 Expand Stroke
    // 物化出来的区域（内圈环在带的外侧轮廓之内、内偏移轮廓之外），所以这样
    // 渲染出来的近似与最终结果一致，代价只是一次骨架贝塞尔遍历。
    //
    // 闭合路径走上面的 cheapBandSubpaths 分支（带必须先按骨架方向归一化，
    // 否则它会从填充里扣掉一块）；这里只剩开放路径，开放路径没有填充区，
    // 带与骨架不会互相抵消。
    return true;
}

function ensureBooleanCache(curve, { allowRebuild = true } = {}) {
    if (!curve?.startNode) return;
    // Fast path: the cache is valid ONLY when the geometry hash still matches
    // what the cache was built from. The old check ("_lastHash != null") never
    // re-validated, so any edit that moved nodes/handles without explicitly
    // clearing _lastHash (e.g. the properties panel bounds edit) rendered the
    // stale boolean outline forever — the path never repainted while the
    // selection box (live bounds) moved. Hash equality is the single source
    // of truth for cache validity.
    if (curve._lastHash != null && curve._lastHash !== curve.getGeometryHash()) {
        curve._lastHash = null; // geometry drifted: force rebuild below
    }
    if (curve._lastHash != null && hasUsableBooleanCache(curve)) return;

    const currentHash = curve.getGeometryHash();
    // invalidateBooleanCache only clears _lastHash; if geometry is unchanged, reuse Paper result.
    if (hasUsableBooleanCache(curve) && curve._booleanContentHash === currentHash) {
        curve._lastHash = currentHash;
        if (!curve._booleanPath2D) {
            curve._booleanPath2D = buildBooleanPath2D(curve.cached_boolean_geometry);
        }
        return;
    }
    // A previous rebuild of THIS exact geometry produced no rings (merge
    // failure — already reported loudly by refreshCurveBooleanCache). Retrying
    // every frame would run the whole Paper.js pipeline per frame while still
    // producing nothing (the "smart object makes panning stutter" symptom) and
    // would re-report the same failure endlessly. Remember the hash so the
    // retry happens as soon as the geometry changes.
    if (curve._booleanEmptyHash === currentHash) return;
    // Stale cache while a gesture is running: do NOT rebuild (see
    // isGeometryGestureActive). Callers fall back to the cheap skeleton/expand
    // paths for this frame; the cache is refreshed when the gesture ends.
    if (!allowRebuild) return;
    curve.updateBooleanCache();
    if (hasUsableBooleanCache(curve)) {
        curve._lastHash = currentHash;
        curve._booleanContentHash = currentHash;
        curve._booleanEmptyHash = null;
    } else {
        // Do NOT poison the validity markers with an empty result: an empty
        // cache used to be recorded as "fresh", so nothing could tell "this
        // curve has no fill to draw" apart from "this curve's geometry yields
        // nothing", and every consumer kept rendering without a fill.
        // The failure itself is reported by refreshCurveBooleanCache.
        curve._lastHash = null;
        curve._booleanContentHash = null;
        curve._booleanEmptyHash = currentHash;
    }
}

/**
 * Skeleton reference line geometry: smart-stroke + width → boolean-merged outer outline; otherwise → center skeleton line.
 * For self-intersecting paths (e.g. figure-eight shapes), use boolean cache directly (union of both-side offsets + original fill),
 * instead of pickOuterOffsetPaths (which can only pick one side and would enter the interior on the other).
 */
export function emitSkeletonReferencePath(ctx, curve, mapPoint, { allowRebuild = true } = {}) {
    if (!ctx || !curve?.startNode) return;
    if (curve.smart_stroke && curve.stroke_width > 0) {
        ensureBooleanCache(curve, { allowRebuild });
        // `hasUsableBooleanCache` only proves the array is non-empty; while a
        // gesture is running the cached geometry can be stale (rebuilds are
        // deferred), so require a matching geometry hash as well — otherwise the
        // reference line would be drawn from the pre-drag geometry.
        if (hasUsableBooleanCache(curve)
            && (allowRebuild || curve._booleanContentHash === curve.getGeometryHash())) {
            emitBooleanSubpaths(ctx, curve.cached_boolean_geometry, mapPoint);
            return;
        }
    }
    emitCubicBezierSegments(ctx, curve.getSkeletonBezierSegments(), mapPoint, {
        close: isCurveClosedRing(curve)
    });
}

/**
 * Batch fill: appends outline to current path (does not beginPath / fill).
 */
export function appendCurveFillPath(ctx, curve, viewport, { refId = null, strokePreview = false, allowRebuild = true } = {}) {
    if (!ctx || !curve?.startNode) return;
    const mapPoint = createViewportTransform(viewport);
    const isClosedRing = isCurveClosedRing(curve);
    const smartBand = curve.smart_stroke && curve.stroke_width > 0;

    if (strokePreview) {
        // Interactive preview: always skeleton. Expanded smart outline is too heavy on
        // dense paths and can fail mid-drag, leaving the mover curve blank.
        emitCubicBezierSegments(ctx, curve.getSkeletonBezierSegments(), mapPoint, { close: isClosedRing });
        return;
    }

    if (smartBand) {
        if (appendSmartStrokeOutline(ctx, curve, mapPoint, { allowBooleanCache: true, allowRebuild })) return;
        // No usable cache while a gesture is running: draw the skeleton so the
        // curve stays visible instead of emitting an outdated band at the old
        // position (the cache is refreshed when the gesture ends).
        //
        // NOTE: there is deliberately NO further fallback here. If the cache is
        // unusable with rebuilds ALLOWED, the merge genuinely failed — that is a
        // broken invariant, and it is reported loudly by
        // refreshCurveBooleanCache (error dialog + error.log) instead of being
        // papered over with un-merged raw geometry, which would hide the defect
        // and make the rendered result disagree with what Expand Stroke produces.
        if (!allowRebuild) {
            emitCubicBezierSegments(ctx, curve.getSkeletonBezierSegments(), mapPoint, { close: isClosedRing });
        }
    }

    const needsSkeletonFill =
        isClosedRing && (!curve.smart_stroke || curve.stroke_width === 0);
    if (needsSkeletonFill) {
        // Draw skeleton bezier segments directly instead of going through boolean cache.
        // Paper.js resolveCrossings in the boolean cache splits self-intersecting paths
        // into subpaths. When the start point's subpath ends up with only the start
        // point as an original node (all other points being intersection division points),
        // that subpath may form a degenerate shape with near-zero area and render blank.
        // The nonzero fill rule handles self-intersections correctly without splitting.
        emitCubicBezierSegments(ctx, curve.getSkeletonBezierSegments(), mapPoint, { close: true });
        return;
    }

    if (!curve.smart_stroke) {
        emitCubicBezierSegments(ctx, curve.getSkeletonBezierSegments(), mapPoint, { close: isClosedRing });
    }
}

/**
 * Stroke layer: fill (optional), stroke width, skeleton preview line.
 */
export function drawCurveStroke(
    ctx,
    curve,
    viewport,
    theme = getCanvasTheme(),
    { renderMode = "stroke", refId = null, strokePreview = false, skipSkeleton = false, allowRebuild = true } = {}
) {
    if (!ctx || !curve?.startNode) return;

    // Prefer Path2D fill for cached smart-stroke (avoids re-emitting huge boolean paths).
    if (
        (renderMode === "fill" || renderMode === "all") &&
        canFillSmartStrokeWithPath2D(curve, { strokePreview, allowRebuild })
    ) {
        fillSmartStrokePath2D(ctx, curve, viewport, theme.path_fill_color);
        if (!skipSkeleton && !strokePreview && (renderMode === "stroke" || renderMode === "all")) {
            ctx.beginPath();
            emitSkeletonReferencePath(ctx, curve, createViewportTransform(viewport), { allowRebuild });
            ctx.lineWidth = 1;
            ctx.strokeStyle = theme.path_stroke_color;
            ctx.stroke();
        }
        return;
    }

    ctx.beginPath();
    appendCurveFillPath(ctx, curve, viewport, { refId, strokePreview, allowRebuild });

    const shouldFill =
        !strokePreview &&
        (curve.smart_stroke
            ? (curve.closed && curve.startNode !== curve.endNode) || curve.stroke_width > 0
            : curve.closed && curve.startNode !== curve.endNode);

    if (renderMode === "fill" || renderMode === "all") {
        if (shouldFill) {
            ctx.fillStyle = theme.path_fill_color;
            ctx.fill("nonzero");
        }
    }

    const scale = viewport.scale ?? 1;

    if (strokePreview) {
        // During high-frequency editing, all strokes use direct lineWidth
        // rendering with the actual stroke width. Smart objects temporarily
        // skip the expensive boolean expand outline — they render as a simple
        // stroked line, cheap enough for real-time editing.
        if (curve.stroke_width > 0 && (renderMode === "stroke" || renderMode === "all")) {
            ctx.lineWidth = curve.stroke_width * scale;
            ctx.strokeStyle = theme.path_fill_color;
            ctx.stroke();
        }
    } else if (!curve.smart_stroke && curve.stroke_width > 0) {
        if (renderMode === "stroke" || renderMode === "all") {
            ctx.lineWidth = curve.stroke_width * scale;
            ctx.strokeStyle = theme.path_fill_color;
            ctx.stroke();
        }
    }

    if (!skipSkeleton && (renderMode === "stroke" || renderMode === "all")) {
        ctx.beginPath();
        if (strokePreview && curve.smart_stroke && curve.stroke_width > 0) {
            // During drag, skip boolean cache (too expensive) and render the
            // skeleton as a simple non-expanded path stroke.
            emitCubicBezierSegments(ctx, curve.getSkeletonBezierSegments(),
                createViewportTransform(viewport), { close: isCurveClosedRing(curve) });
        } else {
            emitSkeletonReferencePath(ctx, curve, createViewportTransform(viewport));
        }
        ctx.lineWidth = 1;
        ctx.strokeStyle = theme.path_stroke_color;
        ctx.stroke();
    }
}

/** Hit-test / export: full outline path */
export function appendCurveOutlinePath(ctx, curve, viewport, { pass = "all", refId = null, strokePreview = false } = {}) {
    if (!ctx || !curve?.startNode) return;
    if (pass === "fill") {
        appendCurveFillPath(ctx, curve, viewport, { refId, strokePreview });
        return;
    }
    if (pass === "skeleton") {
        // Raw pre-expand data: emit the centerline skeleton bezier chain only.
        // For smart strokes this is the model BEFORE boolean expand — used for
        // SVG visual-layer export (stroke preserved as stroke-width, not baked
        // into an expanded outline) and any other "original data" export.
        emitCubicBezierSegments(ctx, curve.getSkeletonBezierSegments(),
            createViewportTransform(viewport), { close: isCurveClosedRing(curve) });
        return;
    }
    if (pass === "stroke" || strokePreview) {
        appendCurveFillPath(ctx, curve, viewport, { refId, strokePreview: true });
        emitSkeletonReferencePath(ctx, curve, createViewportTransform(viewport));
        return;
    }
    appendCurveFillPath(ctx, curve, viewport, { refId, strokePreview });
}
