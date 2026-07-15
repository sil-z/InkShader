import { resolveMarkerById } from "./marker_resolution.js";

/**
 * @typedef {object} TreeCatalog
 * @property {Map<string, object>} treeItems
 * @property {Array<{ id: string, groupId?: string }>} curves
 * @property {Map<string, { id: string, groupId?: string }>} curveById
 * @property {(marker: object) => { id: string, groupId?: string }|null} findCurveByMarker
 */

export function resolveTreeIdForCurve(treeItems, curve) {
    if (!treeItems || !curve) return null;
    if (treeItems.has(curve.id)) return curve.id;
    for (const [id, item] of treeItems) {
        if (item.type === "curve" && item.curveId === curve.id) return id;
    }
    return null;
}

export function createTreeCatalogFromCurveManager(curveManager) {
    if (!curveManager) return null;
    return {
        treeItems: curveManager.treeItems,
        curves: curveManager.curves,
        curveById: curveManager.curveById,
        findCurveByMarker(marker) {
            return curveManager.find_curve_by_dom?.(marker) ?? null;
        },
        resolveMarkerById(markerId) {
            return resolveMarkerById(curveManager, markerId);
        }
    };
}
