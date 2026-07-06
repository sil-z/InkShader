/**
 * Store cold-boot seed (CM → Store once, only on mount/load).
 * Runtime selection corrections must go through EditorStore.commitRuntimeSelectionPatch (via commitInteraction).
 */
import { EDITOR_ACTIONS } from "../domain/actions/editor_actions.js";
import { readInteractionSnapshotFromCurveManager } from "../domain/selection/runtime_interaction_snapshot.js";
import { pickModelRevisionFields } from "./editor_model_sync.js";
import {
    pickDrawToolFieldsFromCanvas,
    pickEllipseToolFieldsFromCanvas,
    pickHistoryStackFields,
    pickViewFieldsFromCanvas
} from "./editor_store_projection.js";

function resolveNodeSelectionRefId(curveManager) {
    if (!curveManager?.node_selecting?.size) return null;
    for (const marker of curveManager.node_selecting) {
        const refId = curveManager.getNodeSelectionRefId?.(marker);
        if (refId) return refId;
    }
    return null;
}

/** @internal Only for EditorStore constructor / seedFromCanvas / IO restore */
export function buildInteractionSeedFromCanvas(canvas) {
    const cm = canvas?.curve_manager;
    const snap = readInteractionSnapshotFromCurveManager(cm);

    const modelFields = pickModelRevisionFields(cm, {
        selectedNodeIds: snap.selectedNodeMarkerIds,
        selectedCurveIds: snap.selectedCurveIds,
        selectedRefIds: snap.selectedRefIds,
        activeGroupId: snap.activeGroupId
    });
    return {
        runtime: {
            currentTool: canvas?.editorStore?.getState?.()?.currentTool || "DRAW",
            ...pickViewFieldsFromCanvas(canvas, {}),
            activeGroupId: snap.activeGroupId,
            selectedTreeIds: snap.selectedTreeIds,
            selectedNodeIds: snap.selectedNodeMarkerIds,
            selectedCurveIds: snap.selectedCurveIds,
            selectedRefIds: snap.selectedRefIds,
            focusedSeqIdx: snap.focusedSeqIdx,
            sequenceText: modelFields.sequenceText,
            activeSequenceIndices: modelFields.activeSequenceIndices,
            sequenceTokens: modelFields.sequenceTokens,
            treeSnapshot: modelFields.treeSnapshot,
            curvesById: modelFields.curvesById,
            nodesByMarkerId: modelFields.nodesByMarkerId,
            clipboardSummary: modelFields.clipboardSummary,
            selectionBoundsTransform: modelFields.selectionBoundsTransform,
            ...pickHistoryStackFields(canvas),
            drawToolSettings: pickDrawToolFieldsFromCanvas(canvas),
            ellipseToolSettings: pickEllipseToolFieldsFromCanvas(canvas)
        }
    };
}

/**
 * After CM's internal validateSelection trims the selection, formally write to Store via reducer (not reconcile/absorb).
 * @returns {boolean} Whether commitInteraction succeeded
 */
export function buildRuntimeSelectionPatchAction(canvas) {
    const cm = canvas?.curve_manager;
    if (!cm) return null;
    const snap = readInteractionSnapshotFromCurveManager(cm);

    if (snap.selectedNodeMarkerIds.length > 0) {
        return {
            type: EDITOR_ACTIONS.CHANGE_NODE_SELECTION,
            payload: {
                strategy: "replace",
                markerIds: snap.selectedNodeMarkerIds,
                refId: resolveNodeSelectionRefId(cm)
            }
        };
    }

    if (snap.selectedCurveIds.length > 0 || snap.selectedRefIds.length > 0) {
        return {
            type: EDITOR_ACTIONS.CHANGE_OBJECT_SELECTION,
            payload: {
                strategy: "replace",
                curveIds: snap.selectedCurveIds,
                refIds: snap.selectedRefIds,
                activeGroupId: snap.activeGroupId ?? undefined
            }
        };
    }

    if (snap.selectedTreeIds.length > 0) {
        return {
            type: EDITOR_ACTIONS.SET_TREE_SELECTION,
            payload: {
                ids: snap.selectedTreeIds,
                activeGroupId: snap.activeGroupId ?? undefined
            }
        };
    }

    return {
        type: EDITOR_ACTIONS.CHANGE_OBJECT_SELECTION,
        payload: { strategy: "clear" }
    };
}
