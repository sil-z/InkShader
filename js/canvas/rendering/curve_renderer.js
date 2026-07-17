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

export function isCurveStrokePreview(canvas, curveId, refId = null) {
    return !!canvas?.isCurveInInteractiveStrokePreview?.(curveId, refId ?? null);
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
export function canFillSmartStrokeWithPath2D(curve, { strokePreview = false } = {}) {
    if (strokePreview) return false;
    if (!curve?.smart_stroke || curve.stroke_width <= 0) return false;
    ensureBooleanCache(curve);
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

function appendSmartStrokeOutline(ctx, curve, mapPoint, { allowBooleanCache = true } = {}) {
    if (!curve?.smart_stroke || curve.stroke_width <= 0) return false;
    const halfWidth = curve.stroke_width / 2;

    if (allowBooleanCache) {
        ensureBooleanCache(curve);
        if (hasUsableBooleanCache(curve)) {
            if (!curve._booleanPath2D) {
                curve._booleanPath2D = buildBooleanPath2D(curve.cached_boolean_geometry);
            }
            emitBooleanSubpaths(ctx, curve.cached_boolean_geometry, mapPoint);
            return true;
        }
    }

    const outline = curve.computeExpandedStrokeOutline(halfWidth);
    if (!outline) return false;
    emitExpandedStrokeOutline(ctx, outline, mapPoint);
    return true;
}

function ensureBooleanCache(curve) {
    if (!curve?.startNode) return;
    // Fast path: already validated for current geometry (set after build / revalidation).
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
    curve.updateBooleanCache();
    curve._lastHash = currentHash;
    curve._booleanContentHash = currentHash;
}

/**
 * Skeleton reference line geometry: smart-stroke + width → boolean-merged outer outline; otherwise → center skeleton line.
 * For self-intersecting paths (e.g. figure-eight shapes), use boolean cache directly (union of both-side offsets + original fill),
 * instead of pickOuterOffsetPaths (which can only pick one side and would enter the interior on the other).
 */
function emitSkeletonReferencePath(ctx, curve, mapPoint) {
    if (!ctx || !curve?.startNode) return;
    if (curve.smart_stroke && curve.stroke_width > 0) {
        ensureBooleanCache(curve);
        if (hasUsableBooleanCache(curve)) {
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
export function appendCurveFillPath(ctx, curve, viewport, { refId = null, strokePreview = false } = {}) {
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
        if (appendSmartStrokeOutline(ctx, curve, mapPoint, { allowBooleanCache: true })) return;
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
    { renderMode = "stroke", refId = null, strokePreview = false } = {}
) {
    if (!ctx || !curve?.startNode) return;

    // Prefer Path2D fill for cached smart-stroke (avoids re-emitting huge boolean paths).
    if (
        (renderMode === "fill" || renderMode === "all") &&
        canFillSmartStrokeWithPath2D(curve, { strokePreview })
    ) {
        fillSmartStrokePath2D(ctx, curve, viewport, theme.path_fill_color);
        if (curve.show_skeleton && !strokePreview && (renderMode === "stroke" || renderMode === "all")) {
            ctx.beginPath();
            emitSkeletonReferencePath(ctx, curve, createViewportTransform(viewport));
            ctx.lineWidth = 1;
            ctx.strokeStyle = theme.path_stroke_color;
            ctx.stroke();
        }
        return;
    }

    ctx.beginPath();
    appendCurveFillPath(ctx, curve, viewport, { refId, strokePreview });

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
        // Skeleton centerline (see appendCurveFillPath); always stroke so dense movers stay visible.
        if (renderMode === "stroke" || renderMode === "all") {
            ctx.lineWidth = 1;
            ctx.strokeStyle = theme.path_stroke_color;
            ctx.stroke();
        }
    } else if (!curve.smart_stroke && curve.stroke_width > 0) {
        if (renderMode === "stroke" || renderMode === "all") {
            ctx.lineWidth = curve.stroke_width * scale;
            ctx.strokeStyle = theme.path_fill_color;
            ctx.stroke();
        }
    }

    if (curve.show_skeleton && !strokePreview && (renderMode === "stroke" || renderMode === "all")) {
        ctx.beginPath();
        emitSkeletonReferencePath(ctx, curve, createViewportTransform(viewport));
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
    if (pass === "stroke" || strokePreview) {
        appendCurveFillPath(ctx, curve, viewport, { refId, strokePreview: true });
        emitSkeletonReferencePath(ctx, curve, createViewportTransform(viewport));
        return;
    }
    appendCurveFillPath(ctx, curve, viewport, { refId, strokePreview });
}
