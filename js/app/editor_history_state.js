/**
 * Undo/Redo: history meta ↔ EditorStore interaction state (aligned with snapshot patch stack).
 */
export function interactionMetaFromCanvas(canvas) {
    const store = canvas?.editorStore?.getState?.();
    const cm = canvas?.curve_manager;
    if (!store) {
        return {
            selection: { treeIds: [], nodes: [] },
            selectedCurveIds: [],
            selectedRefIds: [],
            sequenceText: cm?.sequenceText || "",
            activeIndices: Array.from(cm?.activeSequenceIndices || []),
            activeGroupId: cm?.activeGroupId ?? null,
            currentTool: "DRAW"
        };
    }
    return {
        selection: {
            treeIds: [...(store.selectedTreeIds || [])],
            nodes: [...(store.selectedNodeIds || [])]
        },
        selectedCurveIds: [...(store.selectedCurveIds || [])],
        selectedRefIds: [...(store.selectedRefIds || [])],
        sequenceText: store.sequenceText ?? cm?.sequenceText ?? "",
        activeIndices: [...(store.activeSequenceIndices || [])],
        activeGroupId: store.activeGroupId ?? null,
        currentTool: store.currentTool ?? "DRAW"
    };
}

/** Converts command entry beforeMeta/afterMeta to Store interaction fields */
export function storeInteractionFromHistoryMeta(meta = {}) {
    const patch = {
        selectedTreeIds: [...(meta.selection?.treeIds || [])],
        selectedNodeIds: [...(meta.selection?.nodes || [])],
        selectedCurveIds: [...(meta.selectedCurveIds || [])],
        selectedRefIds: [...(meta.selectedRefIds || [])],
        sequenceText: meta.sequenceText ?? "",
        activeSequenceIndices: [...(meta.activeIndices || [])],
        activeGroupId: meta.activeGroupId ?? null
    };
    // NOTE: currentTool is deliberately NOT restored on undo/redo.
    // The active tool is editor state (which tool the user holds), independent of
    // the document history. beforeMeta.currentTool is captured at command time, so
    // restoring it would snap the tool back to whatever was active when the undone
    // command was recorded — and it goes stale after a tool switch (tool changes
    // are never recorded in history), making the snap wrong on the very next undo.
    return patch;
}
