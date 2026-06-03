/**
 * 从 CurveManager 投影只读模型切片到 EditorStore（app 适配层，非 UI）。
 */
import {
    pickClipboardSummary,
    pickCurvesReadSnapshot,
    pickNodesReadSnapshot
} from "../domain/curves/curve_read_snapshot.js";
import { computeSelectionBounds } from "../domain/selection/selection_bounds.js";
import { buildTreeSnapshot } from "../domain/tree/tree_snapshot.js";
import { mergeInteractionFromStoreState } from "./editor_interaction_state.js";

export function pickTreeSnapshotFromCurveManager(curveManager) {
    return buildTreeSnapshot(curveManager);
}

export function pickSequenceFields(curveManager) {
    if (!curveManager) {
        return { sequenceText: "", activeSequenceIndices: [], sequenceTokens: [] };
    }
    return pickSequenceModelFields(curveManager);
}

export function pickSequenceModelFields(curveManager) {
    if (!curveManager) {
        return { sequenceText: "", activeSequenceIndices: [], sequenceTokens: [] };
    }
    const sequenceText = curveManager.sequenceText || "";
    const tokens =
        typeof curveManager.parseSequence === "function"
            ? curveManager.parseSequence(sequenceText)
            : [];
    return {
        sequenceText,
        activeSequenceIndices: Array.from(curveManager.activeSequenceIndices || []),
        sequenceTokens: tokens.map((t) => ({
            isChar: !!t.isChar,
            value: t.value,
            raw: t.raw,
            display: t.display,
            name: t.name ?? null,
            groupId: t.isChar ? null : t.value
        }))
    };
}

/** 对象选区变更时刷新选区包围盒（纯数据，供属性面板） */
export function pickInteractionReadFields(curveManager, storeState) {
    if (!curveManager || !storeState) {
        return { selectionBoundsTransform: null };
    }
    const hasObject =
        (storeState.selectedCurveIds?.length || 0) > 0 ||
        (storeState.selectedRefIds?.length || 0) > 0;
    if (!hasObject) {
        return { selectionBoundsTransform: null };
    }
    const interaction = mergeInteractionFromStoreState(storeState);
    return {
        selectionBoundsTransform: computeSelectionBounds(curveManager, interaction, "transform")
    };
}

export function pickModelRevisionFields(curveManager, storeState = null) {
    const treeSnapshot = pickTreeSnapshotFromCurveManager(curveManager);
    const markerIds = storeState?.selectedNodeIds || [];
    return {
        treeSnapshot,
        curvesById: pickCurvesReadSnapshot(curveManager),
        nodesByMarkerId: pickNodesReadSnapshot(curveManager, markerIds),
        clipboardSummary: pickClipboardSummary(curveManager),
        ...(storeState ? pickInteractionReadFields(curveManager, storeState) : { selectionBoundsTransform: null }),
        ...pickSequenceModelFields(curveManager)
    };
}
