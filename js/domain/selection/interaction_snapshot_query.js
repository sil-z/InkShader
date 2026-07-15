/**
 * Interaction snapshot queries (pure data, no DOM).
 */

/** Get the count of a collection regardless of whether it's an Array (.length) or Set (.size). */
function collSize(coll) {
    if (coll == null) return 0;
    if (typeof coll.size === 'number') return coll.size;
    if (typeof coll.length === 'number') return coll.length;
    return 0;
}

export function hasObjectSelection(snapshot) {
    return collSize(snapshot.selectedCurveIds) > 0 || collSize(snapshot.selectedRefIds) > 0;
}

export function resolveCurvesFromSnapshot(snapshot, curveManager) {
    if (!curveManager || !snapshot?.selectedCurveIds) return [];
    const ids = snapshot.selectedCurveIds;
    if (collSize(ids) === 0) return [];
    const result = [];
    for (const id of ids) {
        const curve = curveManager.curveById.get(id);
        if (curve) result.push(curve);
    }
    return result;
}

export function resolveRefsFromSnapshot(snapshot, curveManager) {
    if (!curveManager || !snapshot?.selectedRefIds?.length) return [];
    return snapshot.selectedRefIds
        .map((id) => curveManager.treeItems.get(id))
        .filter((item) => item && (item.isRef || item.type === 'image'));
}
