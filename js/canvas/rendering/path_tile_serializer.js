/**
 * Serialize path-layer geometry for Worker / OffscreenCanvas tile paints.
 * Boolean caches must be warmed on the main thread (Paper.js) before serialize.
 */
import { canFillSmartStrokeWithPath2D } from "./curve_renderer.js";

function matrixToPlain(m) {
    if (!m) return null;
    return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f };
}

function cloneBoolean(geom) {
    if (!Array.isArray(geom) || geom.length === 0) return null;
    return geom.map((sub) => ({
        closed: !!sub.closed,
        segments: (sub.segments || []).map((s) => ({
            x: s.x,
            y: s.y,
            inX: s.inX,
            inY: s.inY,
            outX: s.outX,
            outY: s.outY
        }))
    }));
}

function cloneSkeleton(segments) {
    if (!Array.isArray(segments)) return [];
    return segments.map((seg) => ({
        p0: { x: seg.p0.x, y: seg.p0.y },
        p1: { x: seg.p1.x, y: seg.p1.y },
        p2: { x: seg.p2.x, y: seg.p2.y },
        p3: { x: seg.p3.x, y: seg.p3.y }
    }));
}

/**
 * Warm boolean cache then serialize one curve instance for tile paint.
 * @returns {object|null}
 */
export function serializeCurvePaintItem(curve, {
    seqIdx = 0,
    seqOffsetX = 0,
    matrix = null,
    refId = null,
    strokePreview = false
} = {}) {
    if (!curve?.startNode || !curve.id) return null;

    const smart = !!curve.smart_stroke && (curve.stroke_width || 0) > 0 && !strokePreview;
    if (smart) {
        // Main-thread Paper warm — worker never rebuilds boolean.
        canFillSmartStrokeWithPath2D(curve, { strokePreview: false });
    }

    let skeleton = [];
    try {
        skeleton = cloneSkeleton(curve.getSkeletonBezierSegments?.() || []);
    } catch (_) {
        skeleton = [];
    }
    if (skeleton.length === 0 && !curve.cached_boolean_geometry?.length) return null;

    return {
        id: curve.id,
        seqIdx,
        refId: refId ?? null,
        seqOffsetX: seqOffsetX || 0,
        matrix: matrixToPlain(matrix),
        closed: !!curve.closed,
        smart_stroke: !!curve.smart_stroke,
        stroke_width: curve.stroke_width || 0,
        show_skeleton: !!curve.show_skeleton,
        stroke_preview: !!strokePreview,
        skeleton,
        boolean: smart ? cloneBoolean(curve.cached_boolean_geometry) : null
    };
}

/**
 * Build paint items for curves intersecting a world AABB via spatial grid.
 * @param {object} host - canvas host with curve_manager
 * @param {{minX:number,minY:number,maxX:number,maxY:number}} worldRect
 * @returns {object[]}
 */
export function serializePathsForWorldRect(host, worldRect) {
    const cm = host?.curve_manager;
    if (!cm) return [];
    const grid = cm.spatialGrid;
    const activeIndices = cm.activeSequenceIndices || new Set();
    const pad = 2;
    const x = worldRect.minX - pad;
    const y = worldRect.minY - pad;
    const w = (worldRect.maxX - worldRect.minX) + pad * 2;
    const h = (worldRect.maxY - worldRect.minY) + pad * 2;

    let entries = [];
    if (grid && typeof grid.queryCurvesRect === "function") {
        entries = grid.queryCurvesRect(x, y, w, h) || [];
        if (entries.length === 0 && typeof grid.queryRect === "function" && grid.size > 0) {
            const seen = new Set();
            for (const e of grid.queryRect(x, y, w, h)) {
                const id = e.curve?.id;
                if (!id) continue;
                const k = `${id}|${e.seqIdx ?? ""}|${e.refId ?? ""}`;
                if (seen.has(k)) continue;
                seen.add(k);
                entries.push(e);
            }
        }
    }

    const items = [];
    const seen = new Set();
    for (const e of entries) {
        const curve = e.curve;
        const id = e.curveId || curve?.id;
        if (!id || !curve?.startNode) continue;
        if (!activeIndices.has(e.seqIdx)) continue;
        const k = `${id}|${e.seqIdx ?? ""}|${e.refId ?? ""}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const item = serializeCurvePaintItem(curve, {
            seqIdx: e.seqIdx,
            seqOffsetX: e.seqOffsetX ?? cm.getSeqOffset?.(e.seqIdx) ?? 0,
            matrix: e.matrix || null,
            refId: e.refId ?? null,
            strokePreview: false
        });
        if (item) items.push(item);
    }

    // Stable draw order: sequence index then id.
    items.sort((a, b) => (a.seqIdx - b.seqIdx) || String(a.id).localeCompare(String(b.id)));
    return items;
}

/**
 * Serialize all active-sequence curve instances (once per geometry epoch).
 * Prefer this for Worker scene upload so tile jobs stay tiny.
 */
export function serializeAllActivePaths(host) {
    const cm = host?.curve_manager;
    if (!cm) return [];
    const activeIndices = cm.activeSequenceIndices || new Set();
    const tokens = cm.sequenceTokens || [];
    const items = [];
    const seen = new Set();

    for (let i = 0; i < tokens.length; i++) {
        if (!activeIndices.has(i)) continue;
        const token = tokens[i];
        const groupId = token.isChar
            ? cm.getDefaultGroupForChar?.(token.value)
            : token.value;
        if (!groupId) continue;
        const seqOffsetX = cm.getSeqOffset?.(i) ?? 0;
        const list = cm.getCurvesForGroup?.(groupId) || [];
        for (const cd of list) {
            const curve = cd.curve;
            const id = curve?.id;
            if (!id || !curve?.startNode) continue;
            if (cd.effectiveVis === false) continue;
            const k = `${id}|${i}|${cd.refId ?? ""}`;
            if (seen.has(k)) continue;
            seen.add(k);
            const item = serializeCurvePaintItem(curve, {
                seqIdx: i,
                seqOffsetX,
                matrix: cd.matrix || null,
                refId: cd.refId ?? null,
                strokePreview: false
            });
            if (item) items.push(item);
        }
    }
    items.sort((a, b) => (a.seqIdx - b.seqIdx) || String(a.id).localeCompare(String(b.id)));
    return items;
}

/**
 * Yield active path instances one at a time so callers can serialize within a
 * small frame budget instead of blocking the main thread on the whole scene.
 *
 * @param {object} host - Canvas host with a curve manager
 * @returns {Generator<object, void, unknown>}
 */
export function* iterateActivePathPaintItems(host) {
    const cm = host?.curve_manager;
    if (!cm) return;
    const activeIndices = cm.activeSequenceIndices || new Set();
    const tokens = cm.sequenceTokens || [];
    const seen = new Set();

    for (let i = 0; i < tokens.length; i++) {
        if (!activeIndices.has(i)) continue;
        const token = tokens[i];
        const groupId = token.isChar
            ? cm.getDefaultGroupForChar?.(token.value)
            : token.value;
        if (!groupId) continue;
        const seqOffsetX = cm.getSeqOffset?.(i) ?? 0;
        const list = cm.getCurvesForGroup?.(groupId) || [];
        for (const cd of list) {
            const curve = cd.curve;
            const id = curve?.id;
            if (!id || !curve?.startNode || cd.effectiveVis === false) continue;
            const key = `${id}|${i}|${cd.refId ?? ""}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const item = serializeCurvePaintItem(curve, {
                seqIdx: i,
                seqOffsetX,
                matrix: cd.matrix || null,
                refId: cd.refId ?? null,
                strokePreview: false
            });
            if (item) yield item;
        }
    }
}
