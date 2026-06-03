import { resolveMarkerById } from "../selection/marker_resolution.js";

/** 曲线只读字段（供 EditorStore → UI，无 Curve 实例） */
export function pickCurvesReadSnapshot(curveManager) {
    if (!curveManager?.curves) return {};
    const curvesById = {};
    for (const curve of curveManager.curves) {
        let skeletonWinding = "open";
        let skeletonVertexCount = 0;
        if (typeof curve.getSkeletonWinding === "function") {
            skeletonWinding = curve.getSkeletonWinding();
        }
        if (typeof curve.getSkeletonVertices === "function") {
            skeletonVertexCount = curve.getSkeletonVertices().length;
        }
        curvesById[curve.id] = {
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
    return curvesById;
}

/** 当前节点选区的只读几何（markerId → 坐标） */
export function pickNodesReadSnapshot(curveManager, markerIds = []) {
    if (!curveManager || !markerIds?.length) return {};
    const nodesByMarkerId = {};
    for (const markerId of markerIds) {
        const marker = resolveMarkerById(curveManager, markerId);
        const node = curveManager.find_node_by_curve?.(marker);
        if (!node) continue;
        nodesByMarkerId[markerId] = {
            x: node.x,
            y: node.y,
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
