/**
 * Project read-only model slices from CurveManager to EditorStore (app adapter layer, not UI).
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

/** Refresh selection bounds on object selection change (pure data, for property panel) */
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
