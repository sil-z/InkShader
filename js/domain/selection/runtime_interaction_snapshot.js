/**
 * 从 CurveManager 运行时选区集合构建交互快照（无 Store / 无 DOM）。
 */

export function createEmptyRuntimeInteractionSnapshot() {
    return {
        selectedTreeIds: [],
        selectedNodeMarkerIds: [],
        selectedCurveIds: [],
        selectedRefIds: [],
        activeGroupId: null,
        focusedSeqIdx: -1
    };
}

export function readInteractionSnapshotFromCurveManager(curveManager) {
    if (!curveManager) return createEmptyRuntimeInteractionSnapshot();
    return {
        selectedTreeIds: Array.from(curveManager.selectedTreeIds || []),
        selectedNodeMarkerIds: Array.from(curveManager.node_selecting || [])
            .map((marker) => (marker && typeof marker === "object" ? marker.id : marker))
            .filter(Boolean),
        selectedCurveIds: Array.from(curveManager.selected_curves || [])
            .map((curve) => curve?.id)
            .filter(Boolean),
        selectedRefIds: Array.from(curveManager.selected_refs || [])
            .map((ref) => ref?.id)
            .filter(Boolean),
        activeGroupId: curveManager.activeGroupId ?? null,
        focusedSeqIdx:
            typeof curveManager.focused_seq_idx === "number" ? curveManager.focused_seq_idx : -1
    };
}
