import { resolveMarkersByIds } from "../selection/marker_resolution.js";

/** Display-only winding: skip Gauss-Legendre above this on-curve vertex count. */
export const MAX_WINDING_NODES = 400;

/** Count on-curve vertices, stopping once past `max` (avoids allocating full vertex lists). */
function countOnCurveVertices(curve, max = MAX_WINDING_NODES) {
    let n = 0;
    let cur = curve?.startNode || null;
    while (cur) {
        n += 1;
        if (n > max) return n;
        cur = cur.nextOnCurve;
    }
    return n;
}

/**
 * Read-only DTO for one curve (EditorStore / property panel).
 * @param {object} curve
 * @param {{ computeWinding?: boolean }} [options]
 */
export function pickCurveReadFields(curve, { computeWinding = false } = {}) {
    if (!curve) return null;
    let skeletonWinding = "open";
    let skeletonVertexCount = 0;
    if (computeWinding) {
        skeletonVertexCount = countOnCurveVertices(curve, MAX_WINDING_NODES);
        if (
            skeletonVertexCount > 0 &&
            skeletonVertexCount <= MAX_WINDING_NODES &&
            typeof curve.getSkeletonWinding === "function"
        ) {
            skeletonWinding = curve.getSkeletonWinding();
        }
    }
    return {
        id: curve.id,
        groupId: curve.groupId ?? null,
        visible: curve.visible !== false,
        locked: curve.locked === true,
        stroke_width: curve.stroke_width,
        closed: !!curve.closed,
        smart_stroke: !!curve.smart_stroke,
        show_skeleton: !!curve.show_skeleton,
        smart_stroke_clockwise: curve.smart_stroke_clockwise !== false,
        skeletonWinding,
        skeletonVertexCount
    };
}

/**
 * Project curve DTOs into EditorStore.
 * Lazy: only selected (and optional extra) ids — O(S), not O(C).
 * UI lookups for other ids go through getCurveById → live CurveManager fallback.
 */
export function pickCurvesReadSnapshot(curveManager, options = {}) {
    if (!curveManager?.curveById) return {};
    const curvesById = {};
    const ids = new Set(options.selectedCurveIds || []);
    for (const id of options.extraCurveIds || []) {
        if (id) ids.add(id);
    }
    for (const id of ids) {
        const curve = curveManager.curveById.get(id);
        if (!curve) continue;
        curvesById[id] = pickCurveReadFields(curve, { computeWinding: true });
    }
    return curvesById;
}

/** Cap for property-panel node snapshots — UI only needs the last selected node. */
const MAX_NODE_READ_SNAPSHOT = 64;

/** Read-only geometry of current node selection (markerId → coordinates) */
export function pickNodesReadSnapshot(curveManager, markerIds = []) {
    if (!curveManager || !markerIds?.length) return {};
    const ids =
        markerIds.length > MAX_NODE_READ_SNAPSHOT
            ? markerIds.slice(-MAX_NODE_READ_SNAPSHOT)
            : markerIds;
    const markers = resolveMarkersByIds(curveManager, ids);
    const nodesByMarkerId = {};
    for (const marker of markers) {
        const node = curveManager.find_node_by_curve?.(marker);
        if (!node || !marker?.id) continue;
        nodesByMarkerId[marker.id] = {
            x: node.x,
            y: node.y,
            groupId: node.curve?.groupId || null,
            control1: node.control1
                ? { x: node.control1.x, y: node.control1.y }
                : null,
            control2: node.control2
                ? { x: node.control2.x, y: node.control2.y }
                : null
        };
    }
    return nodesByMarkerId;
}

export function pickClipboardSummary(curveManager) {
    const clip = curveManager?.clipboard;
    if (!clip?.length) return { canPaste: false, count: 0, firstType: null };
    return { canPaste: true, count: clip.length, firstType: clip[0]?.type ?? null };
}
