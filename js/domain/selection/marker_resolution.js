/**
 * Resolve node markers from interaction snapshot / domMap (no UI / no EventBus).
 */
import { getCanvasCommandPort } from "../ports/canvas_command_host_port.js";

/**
 * Build marker.id → { marker, live } once. Callers that resolve many IDs MUST use this
 * (or resolveMarkersByIds) — per-id full domMap scans are O(|selection| × |domMap|).
 */
export function buildMarkerIdIndex(curveManager) {
    const t0 = performance.now();
    const byId = new Map();
    if (!curveManager?.domMap) return byId;
    const cbId = curveManager.curveById;
    for (const [marker, node] of curveManager.domMap.entries()) {
        if (!marker?.id) continue;
        const curveId = node?.curve?.id;
        const isLive = !!(curveId && cbId?.has(curveId));
        const prev = byId.get(marker.id);
        if (!prev || (isLive && !prev.live)) {
            byId.set(marker.id, { marker, live: isLive });
        }
    }
    const t1 = performance.now();
    if (t1 - t0 > 5) console.warn(`[PERF] buildMarkerIdIndex: ${(t1-t0).toFixed(1)}ms domMap=${curveManager.domMap.size} entries=${byId.size}`);
    return byId;
}

export function resolveMarkersByIds(curveManager, markerIds = []) {
    if (!curveManager || markerIds.length === 0) return [];
    const byId = buildMarkerIdIndex(curveManager);
    const out = [];
    for (const id of markerIds) {
        const entry = byId.get(id);
        if (entry) out.push(entry.marker);
    }
    return out;
}

export function resolveMarkerById(curveManager, markerId) {
    if (!curveManager || !markerId) return null;
    const cbId = curveManager.curveById;
    let fallback = null;
    for (const [marker, node] of curveManager.domMap.entries()) {
        if (marker?.id !== markerId) continue;
        const curveId = node?.curve?.id;
        if (curveId && cbId?.has(curveId)) return marker;
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
    const ids = snapshot?.selectedNodeMarkerIds || new Set();
    return resolveMarkersByIds(cm, [...ids]);
}
