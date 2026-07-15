/**
 * Builds interaction snapshot from CurveManager runtime selection sets (no Store / no DOM).
 */

export function createEmptyRuntimeInteractionSnapshot() {
    return {
        selectedTreeIds: [],
        selectedNodeMarkerIds: new Set(),
        selectedCurveIds: new Set(),
        selectedRefIds: [],
        activeGroupId: null,
        focusedSeqIdx: -1
    };
}

export function readInteractionSnapshotFromCurveManager(curveManager) {
    if (!curveManager) return createEmptyRuntimeInteractionSnapshot();
    const markerIds = Array.from(curveManager.node_selecting || [])
        .map((marker) => (marker && typeof marker === "object" ? marker.id : marker))
        .filter(Boolean);
    return {
        selectedTreeIds: Array.from(curveManager.selectedTreeIds || []),
        selectedNodeMarkerIds: new Set(markerIds),
        selectedCurveIds: new Set(
            Array.from(curveManager.selected_curves || [])
                .map((curve) => curve?.id)
                .filter(Boolean)
        ),
        selectedRefIds: Array.from(curveManager.selected_refs || [])
            .map((ref) => ref?.id)
            .filter(Boolean),
        activeGroupId: curveManager.activeGroupId ?? null,
        focusedSeqIdx:
            typeof curveManager.focused_seq_idx === "number" ? curveManager.focused_seq_idx : -1
    };
}
