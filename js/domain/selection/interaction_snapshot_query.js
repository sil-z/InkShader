/**
 * 交互快照查询（纯数据，无 DOM）。
 */

export function hasObjectSelection(snapshot) {
    return snapshot.selectedCurveIds?.length > 0 || snapshot.selectedRefIds?.length > 0;
}

export function resolveCurvesFromSnapshot(snapshot, curveManager) {
    if (!curveManager || !snapshot?.selectedCurveIds?.length) return [];
    const ids = new Set(snapshot.selectedCurveIds);
    return curveManager.curves.filter((curve) => ids.has(curve.id));
}

export function resolveRefsFromSnapshot(snapshot, curveManager) {
    if (!curveManager || !snapshot?.selectedRefIds?.length) return [];
    return snapshot.selectedRefIds
        .map((id) => curveManager.treeItems.get(id))
        .filter((item) => item && (item.isRef || item.type === 'image'));
}
