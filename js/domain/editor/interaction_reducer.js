import { EDITOR_ACTIONS } from "../actions/editor_actions.js";

export function defaultDrawToolSettings() {
    return {
        stroke_width: 0,
        closed: true,
        smart_expand: true,
        show_skeleton: true
    };
}

export function defaultEllipseToolSettings() {
    return {
        stroke_width: 0,
        closed: true,
        smart_expand: true,
        show_skeleton: true
    };
}
import { deriveTreeFieldsFromState } from "../selection/derive_tree_fields.js";
import { createTreeCatalogFromCurveManager } from "../selection/tree_catalog.js";

function reduceObjectSelection(state, payload = {}) {
    const strategy = payload.strategy || "replace";
    const curveIds = [...(payload.curveIds || [])];
    const refIds = [...(payload.refIds || [])];
    let selectedCurveIds = [...(state.selectedCurveIds || [])];
    let selectedRefIds = [...(state.selectedRefIds || [])];

    switch (strategy) {
        case "replace":
            selectedCurveIds = curveIds;
            selectedRefIds = refIds;
            break;
        case "add":
            selectedCurveIds = [...new Set([...selectedCurveIds, ...curveIds])];
            selectedRefIds = [...new Set([...selectedRefIds, ...refIds])];
            break;
        case "remove":
            selectedCurveIds = selectedCurveIds.filter((id) => !curveIds.includes(id));
            selectedRefIds = selectedRefIds.filter((id) => !refIds.includes(id));
            break;
        case "toggle": {
            for (const id of curveIds) {
                if (selectedCurveIds.includes(id)) {
                    selectedCurveIds = selectedCurveIds.filter((x) => x !== id);
                } else selectedCurveIds.push(id);
            }
            for (const id of refIds) {
                if (selectedRefIds.includes(id)) {
                    selectedRefIds = selectedRefIds.filter((x) => x !== id);
                } else selectedRefIds.push(id);
            }
            break;
        }
        case "clear":
            selectedCurveIds = [];
            selectedRefIds = [];
            break;
        default:
            break;
    }

    const next = {
        ...state,
        selectedCurveIds,
        selectedRefIds,
        selectedNodeIds: [],
        selectedTreeIds: [],
        _nodeSelectionRefId: null
    };
    if (payload.activeGroupId !== undefined && payload.activeGroupId !== null) {
        next.activeGroupId = payload.activeGroupId;
    }
    return next;
}

function reduceNodeSelection(state, payload = {}) {
    const strategy = payload.strategy || "replace";
    const markerIds = [...(payload.markerIds || [])];
    let selectedNodeIds = [...(state.selectedNodeIds || [])];

    switch (strategy) {
        case "replace":
            selectedNodeIds = markerIds;
            break;
        case "add":
            selectedNodeIds = [...new Set([...selectedNodeIds, ...markerIds])];
            break;
        case "remove":
            selectedNodeIds = selectedNodeIds.filter((id) => !markerIds.includes(id));
            break;
        case "toggle": {
            for (const id of markerIds) {
                if (selectedNodeIds.includes(id)) {
                    selectedNodeIds = selectedNodeIds.filter((x) => x !== id);
                } else selectedNodeIds.push(id);
            }
            break;
        }
        case "clear":
            selectedNodeIds = [];
            break;
        default:
            break;
    }

    return {
        ...state,
        selectedNodeIds,
        selectedCurveIds: [],
        selectedRefIds: [],
        selectedTreeIds: [],
        _nodeSelectionRefId: payload.refId ?? null
    };
}

export function finalizeInteractionState(state, curveManager = null, actionType = null) {
    if (
        actionType === EDITOR_ACTIONS.CHANGE_NODE_SELECTION ||
        actionType === EDITOR_ACTIONS.CHANGE_OBJECT_SELECTION ||
        actionType === EDITOR_ACTIONS.SET_TREE_SELECTION
    ) {
        const catalog = createTreeCatalogFromCurveManager(curveManager);
        return { ...state, ...deriveTreeFieldsFromState(state, catalog) };
    }
    return state;
}

/**
 * Store interaction state reducer (pure function; curveManager used only for id derivation, does not read CM selection set).
 */
export function reduceInteractionState(state, action, curveManager = null) {
    const payload = action?.payload || {};
    let next = state;
    switch (action?.type) {
        case EDITOR_ACTIONS.SET_TOOL_MODE:
            return { ...state, currentTool: payload.mode };
        case EDITOR_ACTIONS.SET_TREE_SELECTION: {
            next = {
                ...state,
                selectedTreeIds: [...(payload.ids || [])],
                selectedNodeIds: [],
                selectedCurveIds: [],
                selectedRefIds: [],
                _nodeSelectionRefId: null
            };
            if (payload.activeGroupId !== undefined && payload.activeGroupId !== null) {
                next.activeGroupId = payload.activeGroupId;
            }
            break;
        }
        case EDITOR_ACTIONS.SET_ACTIVE_GROUP:
            return { ...state, activeGroupId: payload.id ?? null };
        case EDITOR_ACTIONS.SET_FOCUSED_SEQUENCE_INDEX:
            return {
                ...state,
                focusedSeqIdx: typeof payload.index === "number" ? payload.index : -1
            };
        case EDITOR_ACTIONS.SET_DRAW_TOOL_SETTINGS: {
            const patch = payload.settings || payload;
            const prev = state.drawToolSettings || defaultDrawToolSettings();
            return {
                ...state,
                drawToolSettings: {
                    stroke_width: patch.stroke_width ?? prev.stroke_width,
                    closed: patch.closed ?? prev.closed,
                    smart_expand: patch.smart_expand ?? prev.smart_expand,
                    show_skeleton: patch.show_skeleton ?? prev.show_skeleton
                }
            };
        }
        case EDITOR_ACTIONS.SET_ELLIPSE_TOOL_SETTINGS: {
            const epatch = payload.settings || payload;
            const eprev = state.ellipseToolSettings || defaultEllipseToolSettings();
            return {
                ...state,
                ellipseToolSettings: {
                    stroke_width: epatch.stroke_width ?? eprev.stroke_width,
                    closed: epatch.closed ?? eprev.closed,
                    smart_expand: epatch.smart_expand ?? eprev.smart_expand,
                    show_skeleton: epatch.show_skeleton ?? eprev.show_skeleton
                }
            };
        }
        case EDITOR_ACTIONS.SET_SEQUENCE_EDITOR_STATE: {
            const patch = payload.payload || {};
            next = { ...state };
            if (patch.text !== undefined) next.sequenceText = patch.text;
            if (patch.activeIndices !== undefined) {
                next.activeSequenceIndices = [...patch.activeIndices];
            }
            return next;
        }
        case EDITOR_ACTIONS.DELETE_GROUP_AND_UPDATE_SEQUENCE: {
            const seq = payload.payload || {};
            return {
                ...state,
                sequenceText: seq.text ?? state.sequenceText,
                activeSequenceIndices: [...(seq.activeIndices || [])],
                selectedTreeIds: [],
                selectedNodeIds: [],
                selectedCurveIds: [],
                selectedRefIds: [],
                _nodeSelectionRefId: null
            };
        }
        case EDITOR_ACTIONS.CHANGE_OBJECT_SELECTION:
            next = reduceObjectSelection(state, payload);
            break;
        case EDITOR_ACTIONS.CHANGE_NODE_SELECTION:
            next = reduceNodeSelection(state, payload);
            break;
        case "__INIT__":
        case "SEED_FROM_RUNTIME": {
            const runtime = payload.runtime || {};
            return {
                ...state,
                currentTool: runtime.currentTool ?? state.currentTool ?? "DRAW",
                currentState: runtime.currentState ?? state.currentState,
                scale: runtime.scale ?? state.scale,
                offset: runtime.offset
                    ? { ...runtime.offset }
                    : state.offset
                      ? { ...state.offset }
                      : { x: 0, y: 0 },
                activeGroupId: runtime.activeGroupId ?? null,
                selectedTreeIds: [...(runtime.selectedTreeIds || [])],
                selectedNodeIds: [...(runtime.selectedNodeIds || [])],
                selectedCurveIds: [...(runtime.selectedCurveIds || [])],
                selectedRefIds: [...(runtime.selectedRefIds || [])],
                focusedSeqIdx: runtime.focusedSeqIdx ?? -1,
                sequenceText: runtime.sequenceText ?? "",
                activeSequenceIndices: [...(runtime.activeSequenceIndices || [])],
                commandStackSize: runtime.commandStackSize ?? 0,
                redoStackSize: runtime.redoStackSize ?? 0,
                isRestoring: runtime.isRestoring === true,
                drawToolSettings: runtime.drawToolSettings
                    ? { ...runtime.drawToolSettings }
                    : state.drawToolSettings || defaultDrawToolSettings(),
                ellipseToolSettings: runtime.ellipseToolSettings
                    ? { ...runtime.ellipseToolSettings }
                    : state.ellipseToolSettings || defaultEllipseToolSettings(),
                treeSnapshot: runtime.treeSnapshot
                    ? {
                          rootChildren: [...(runtime.treeSnapshot.rootChildren || [])],
                          items: { ...(runtime.treeSnapshot.items || {}) },
                          charToGroupId: { ...(runtime.treeSnapshot.charToGroupId || {}) }
                      }
                    : state.treeSnapshot,
                sequenceTokens: Array.isArray(runtime.sequenceTokens)
                    ? runtime.sequenceTokens.map((t) => ({ ...t }))
                    : state.sequenceTokens,
                curvesById: runtime.curvesById ? { ...runtime.curvesById } : state.curvesById,
                nodesByMarkerId: runtime.nodesByMarkerId
                    ? { ...runtime.nodesByMarkerId }
                    : state.nodesByMarkerId,
                clipboardSummary: runtime.clipboardSummary
                    ? { ...runtime.clipboardSummary }
                    : state.clipboardSummary,
                selectionBoundsTransform: runtime.selectionBoundsTransform
                    ? { ...runtime.selectionBoundsTransform }
                    : state.selectionBoundsTransform
            };
        }
        default:
            return state;
    }
    // NOTE: Do NOT call finalizeInteractionState here — callers
    // (_preDispatchInteraction / commitInteraction) always finalize after reduce.
    return next;
}

export const INTERACTION_PAYLOAD_ACTIONS = Object.freeze(
    new Set([
        EDITOR_ACTIONS.SET_TOOL_MODE,
        EDITOR_ACTIONS.SET_TREE_SELECTION,
        EDITOR_ACTIONS.SET_ACTIVE_GROUP,
        EDITOR_ACTIONS.SET_FOCUSED_SEQUENCE_INDEX,
        EDITOR_ACTIONS.SET_SEQUENCE_EDITOR_STATE,
        EDITOR_ACTIONS.DELETE_GROUP_AND_UPDATE_SEQUENCE,
        EDITOR_ACTIONS.CHANGE_OBJECT_SELECTION,
        EDITOR_ACTIONS.CHANGE_NODE_SELECTION,
        EDITOR_ACTIONS.SET_DRAW_TOOL_SETTINGS,
        EDITOR_ACTIONS.SET_ELLIPSE_TOOL_SETTINGS
    ])
);
