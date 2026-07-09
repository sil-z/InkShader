import { resolveTreeIdForCurve } from "./tree_catalog.js";

/**
 * Derives tree selection from Store selection fields (pure logic; catalog used only for id resolution).
 * @param {object} state
 * @param {import("./tree_catalog.js").TreeCatalog|null} catalog
 */
export function deriveTreeFieldsFromState(state, catalog = null) {
    if (!state) return { selectedTreeIds: [], activeGroupId: null };

    const treeItems = catalog?.treeItems;
    const nodeIds = state.selectedNodeIds || [];

    if (nodeIds.length > 0 && catalog) {
        const selectedTreeIds = new Set();
        const selectedCurveIds = [];
        const seenCurveIds = new Set();
        let lastGroupId = state.activeGroupId ?? null;
        const refId = state._nodeSelectionRefId ?? null;

        for (const markerId of nodeIds) {
            if (refId && treeItems?.has(refId)) {
                selectedTreeIds.add(refId);
                const refItem = treeItems.get(refId);
                if (refItem?.parentId) lastGroupId = refItem.parentId;
                continue;
            }
            const marker = catalog.resolveMarkerById(markerId);
            if (!marker) continue;
            const curve = catalog.findCurveByMarker(marker);
            if (curve && !seenCurveIds.has(curve.id)) {
                seenCurveIds.add(curve.id);
                selectedCurveIds.push(curve.id);
            }
            const treeId = resolveTreeIdForCurve(treeItems, curve);
            if (treeId) {
                selectedTreeIds.add(treeId);
                if (curve?.groupId) lastGroupId = curve.groupId;
            }
        }
        return { selectedTreeIds: [...selectedTreeIds], selectedCurveIds, activeGroupId: lastGroupId };
    }

    if ((state.selectedTreeIds || []).length > 0) {
        const selectedCurveIds = [];
        const selectedRefIds = [];
        let lastGroupId = state.activeGroupId ?? null;

        if (catalog) {
            for (const id of state.selectedTreeIds) {
                const item = treeItems.get(id);
                if (!item) continue;
                if (item.type === "curve") {
                    const curve = catalog.curves.find((c) => c.id === item.curveId);
                    if (curve) {
                        selectedCurveIds.push(curve.id);
                        if (curve.groupId) lastGroupId = curve.groupId;
                    }
                } else if (item.type === "group") {
                    if (item.isRef) {
                        selectedRefIds.push(id);
                        if (item.parentId) lastGroupId = item.parentId;
                    } else {
                        lastGroupId = id;
                    }
                } else if (item.type === "image") {
                    selectedRefIds.push(id);
                    if (item.parentId) lastGroupId = item.parentId;
                }
            }
        }

        return {
            selectedTreeIds: [...state.selectedTreeIds],
            selectedCurveIds,
            selectedRefIds,
            activeGroupId: lastGroupId
        };
    }

    const selectedTreeIds = new Set();
    let lastGroupId = state.activeGroupId ?? null;

    if (catalog) {
        for (const curveId of state.selectedCurveIds || []) {
            const curve = catalog.curves.find((c) => c.id === curveId);
            const treeId = resolveTreeIdForCurve(treeItems, curve);
            if (treeId) {
                selectedTreeIds.add(treeId);
                if (curve?.groupId) lastGroupId = curve.groupId;
            }
        }
        for (const refId of state.selectedRefIds || []) {
            if (treeItems.has(refId)) {
                selectedTreeIds.add(refId);
                const refItem = treeItems.get(refId);
                if (refItem?.parentId) lastGroupId = refItem.parentId;
            }
        }
    }

    return { selectedTreeIds: [...selectedTreeIds], activeGroupId: lastGroupId };
}
