/**
 * Curve Canvas rendering: reads domain geometry, applies theme and viewport, calls Canvas API.
 */
import { getCanvasTheme } from "./canvas_theme.js";
import {
    emitBooleanSubpaths,
    emitCubicBezierSegments,
    emitExpandedStrokeOutline
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
 * Interactive preview: smart stroke (including open paths) still batch-fills expanded outline; only non-smart closed rings use skeleton preview.
 */
export function shouldBatchFillCurve(curve, { strokePreview = false } = {}) {
    if (!curveGeneratesFillArea(curve)) return false;
    if (strokePreview) {
        if (curve.smart_stroke && curve.stroke_width > 0) return true;
        return isCurveClosedRing(curve);
    }
    return true;
}

/** Whether to use only center skeleton for batch fill (skips boolean/expand); smart-stroke preview does not use this branch */
export function usePreviewSkeletonForBatchFill(curve, { strokePreview = false } = {}) {
    if (!strokePreview || (curve.smart_stroke && curve.stroke_width > 0)) return false;
    return isCurveClosedRing(curve);
}

function appendSmartStrokeOutline(ctx, curve, mapPoint, { allowBooleanCache = true } = {}) {
    if (!curve?.smart_stroke || curve.stroke_width <= 0) return false;
    const halfWidth = curve.stroke_width / 2;

    if (allowBooleanCache) {
        ensureBooleanCache(curve);
        if (hasUsableBooleanCache(curve)) {
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
    const currentHash = curve.getGeometryHash();
    if (curve._lastHash !== currentHash || !hasUsableBooleanCache(curve)) {
        curve.updateBooleanCache();
        curve._lastHash = currentHash;
    }
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
        if (smartBand) {
            appendSmartStrokeOutline(ctx, curve, mapPoint, { allowBooleanCache: false });
            return;
        }
        emitCubicBezierSegments(ctx, curve.getSkeletonBezierSegments(), mapPoint, { close: isClosedRing });
        return;
    }

    if (smartBand) {
        if (appendSmartStrokeOutline(ctx, curve, mapPoint, { allowBooleanCache: true })) return;
    }

    const needsSkeletonFill =
        isClosedRing && (!curve.smart_stroke || curve.stroke_width === 0);
    if (needsSkeletonFill) {
        ensureBooleanCache(curve);
        if (hasUsableBooleanCache(curve)) {
            emitBooleanSubpaths(ctx, curve.cached_boolean_geometry, mapPoint);
            return;
        }
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
        // Smart-stroke outline already drawn in batch-fill pass; do not fake stroke with center-line + lineWidth
        if (!(curve.smart_stroke && curve.stroke_width > 0) && (renderMode === "stroke" || renderMode === "all")) {
            ctx.lineWidth = curve.stroke_width > 0 ? curve.stroke_width * scale : 1;
            ctx.strokeStyle = curve.stroke_width > 0 ? theme.path_fill_color : theme.path_stroke_color;
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
