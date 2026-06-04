/**
 * 曲线 Canvas 呈现：读取领域几何，应用主题与视口，调用 Canvas API。
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

/** 布尔缓存有效（空数组 [] 视为未缓存，须走扩张描边回退路径） */
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
 * 是否进入「按组批填充」pass。
 * 交互预览：智能描边（含开放路径）仍批填充扩张轮廓；仅非智能的闭合环可用骨架预览。
 */
export function shouldBatchFillCurve(curve, { strokePreview = false } = {}) {
    if (!curveGeneratesFillArea(curve)) return false;
    if (strokePreview) {
        if (curve.smart_stroke && curve.stroke_width > 0) return true;
        return isCurveClosedRing(curve);
    }
    return true;
}

/** 批填充时是否仅用中心骨架（跳过布尔/扩张）；智能描边预览不走此分支 */
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
 * 骨架参考线几何：智能描边 + 有宽度 → 布尔熔合外轮廓；否则 → 中心骨架线。
 * 对八字形等自交路径，直接用布尔缓存（两侧偏移 + 原始填充的 union），
 * 而非 pickOuterOffsetPaths（只能选一侧，在另一侧会陷入内部）。
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
 * 批处理填充：向当前 path 追加轮廓（不 beginPath / 不 fill）。
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

    if (!curve.smart_stroke && isClosedRing) {
        emitCubicBezierSegments(ctx, curve.getSkeletonBezierSegments(), mapPoint, { close: true });
    }
}

/**
 * 描边层：填充（可选）、描边宽度、骨架预览线。
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
        // 智能描边轮廓已在批填充 pass 画出；勿用中心线 + lineWidth 冒充描边
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

/** 命中测试 / 导出：完整轮廓 path */
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
