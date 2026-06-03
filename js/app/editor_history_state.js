/**
 * 撤回/重做：历史 meta ↔ EditorStore 交互态（与 snapshot patch 栈对齐）。
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

/** 将命令条目的 beforeMeta/afterMeta 转为 Store 交互字段 */
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
    if (meta.currentTool !== undefined && meta.currentTool !== null) {
        patch.currentTool = meta.currentTool;
    }
    return patch;
}
