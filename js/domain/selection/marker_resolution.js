/**
 * Resolve node markers from interaction snapshot / domMap (no UI / no EventBus).
 */
import { getCanvasCommandPort } from "../ports/canvas_command_host_port.js";

export function resolveMarkersByIds(curveManager, markerIds = []) {
    if (!curveManager || markerIds.length === 0) return [];
    const liveCurveIds = new Set(curveManager.curves.map((c) => c.id));
    const idSet = new Set(markerIds);
    const byId = new Map();
    for (const [marker, node] of curveManager.domMap.entries()) {
        if (!marker?.id || !idSet.has(marker.id)) continue;
        const curveId = node?.curve?.id;
        const isLive = curveId && liveCurveIds.has(curveId);
        const prev = byId.get(marker.id);
        if (!prev || (isLive && !prev.live)) {
            byId.set(marker.id, { marker, live: isLive });
        }
    }
    return [...byId.values()].map((e) => e.marker);
}

export function resolveMarkerById(curveManager, markerId) {
    if (!curveManager || !markerId) return null;
    const liveCurveIds = new Set(curveManager.curves.map((c) => c.id));
    let fallback = null;
    for (const [marker, node] of curveManager.domMap.entries()) {
        if (marker?.id !== markerId) continue;
        const curveId = node?.curve?.id;
        if (curveId && liveCurveIds.has(curveId)) return marker;
        if (!fallback) fallback = marker;
    }
    return fallback;
}

/**
 * @param {object} canvas requires curve_manager and commandHostPort.getInteractionSnapshot
 */
export function resolveMarkersFromCanvas(canvas) {
    const cm = canvas?.curve_manager;
    if (!cm) return [];
    const snapshot = getCanvasCommandPort(canvas).getInteractionSnapshot();
    const ids = snapshot?.selectedNodeMarkerIds || [];
    return ids.map((id) => resolveMarkerById(cm, id)).filter(Boolean);
}
