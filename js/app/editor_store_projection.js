/**
 * Store → Canvas / CurveManager unidirectional projection (operator).
 * Do NOT read CM state from this file to write back to Store.
 */
import { EDITOR_ACTIONS } from "../domain/actions/editor_actions.js";
import { defaultDrawToolSettings, defaultEllipseToolSettings } from "../domain/editor/interaction_reducer.js";
import { resolveMarkersByIds } from "../domain/selection/marker_resolution.js";

const SEQUENCE_APPLY_ACTIONS = new Set([
    EDITOR_ACTIONS.SET_SEQUENCE_EDITOR_STATE,
    EDITOR_ACTIONS.DELETE_GROUP_AND_UPDATE_SEQUENCE,
    "SEED_FROM_RUNTIME",
    "REFRESH_SEQUENCE",
    "HISTORY_APPLY"
]);

const SEQUENCE_CM_FROM_EXECUTOR_ONLY = new Set([
    EDITOR_ACTIONS.SET_SEQUENCE_EDITOR_STATE,
    EDITOR_ACTIONS.DELETE_GROUP_AND_UPDATE_SEQUENCE
]);

/** Project Store interaction state onto CurveManager / main-canvas */
export function applyInteractionFromStore(canvas, state, { actionType = null } = {}) {
    if (!canvas || !state) return;
    const cm = canvas.curve_manager;
    if (!cm) return;

    // Only sync drawToolSettings from store when the action explicitly changes them.
    // Other action types (e.g. SET_SEQUENCE_EDITOR_STATE during restore) would
    // overwrite canvas values with stale store defaults, breaking view state persistence.
    if (state.drawToolSettings && canvas.drawToolSettings &&
        actionType === EDITOR_ACTIONS.SET_DRAW_TOOL_SETTINGS) {
        const d = state.drawToolSettings;
        const t = canvas.drawToolSettings;
        if (t.stroke_width !== d.stroke_width) t.stroke_width = d.stroke_width;
        if (t.closed !== d.closed) t.closed = d.closed;
        if (t.smart_expand !== d.smart_expand) t.smart_expand = d.smart_expand;
        if (t.show_skeleton !== d.show_skeleton) t.show_skeleton = d.show_skeleton;
    }

    if (state.ellipseToolSettings && canvas.ellipseToolSettings &&
        actionType === EDITOR_ACTIONS.SET_ELLIPSE_TOOL_SETTINGS) {
        const d = state.ellipseToolSettings;
        const t = canvas.ellipseToolSettings;
        if (t.stroke_width !== d.stroke_width) t.stroke_width = d.stroke_width;
        if (t.closed !== d.closed) t.closed = d.closed;
        if (t.smart_expand !== d.smart_expand) t.smart_expand = d.smart_expand;
        if (t.show_skeleton !== d.show_skeleton) t.show_skeleton = d.show_skeleton;
    }

    const focusedIdx = typeof state.focusedSeqIdx === "number" ? state.focusedSeqIdx : -1;
    if (cm.focused_seq_idx !== focusedIdx) {
        cm.focused_seq_idx = focusedIdx;
    }

    const applySequence =
        actionType === null || SEQUENCE_APPLY_ACTIONS.has(actionType) || actionType === "REFRESH_SEQUENCE";
    if (
        applySequence &&
        (state.sequenceText !== undefined || state.activeSequenceIndices !== undefined) &&
        !SEQUENCE_CM_FROM_EXECUTOR_ONLY.has(actionType)
    ) {
        cm.setSequenceState({
            text: state.sequenceText,
            activeIndices: state.activeSequenceIndices
        });
    }

    if (state.activeGroupId !== cm.activeGroupId) {
        cm.updateActiveGroup(state.activeGroupId);
    }

    if (actionType === EDITOR_ACTIONS.SET_TREE_SELECTION) {
        if (state.activeGroupId !== undefined && state.activeGroupId !== cm.activeGroupId) {
            cm.updateActiveGroup(state.activeGroupId);
        }
        cm.setTreeSelection([...(state.selectedTreeIds || [])]);
        return;
    }

    const nodeIds = state.selectedNodeIds || [];
    if (nodeIds.length > 0) {
        const t0 = performance.now();
        const markers = resolveMarkersByIds(cm, nodeIds);
        const t1 = performance.now();
        cm.changeNodeSelection("replace", markers, state._nodeSelectionRefId ?? null);
        const t2 = performance.now();
        if (t2 - t0 > 5) console.warn(`[PERF] applyInteractionFromStore: resolveMarkersByIds=${(t1-t0).toFixed(1)}ms changeNodeSelection=${(t2-t1).toFixed(1)}ms markers=${markers.length}`);
        return;
    }

    const treeIds = state.selectedTreeIds || [];
    if (treeIds.length > 0) {
        cm.setTreeSelection(treeIds);
        return;
    }

    // Handle object selection: resolve curves and refs from store state
    // Normalize to Arrays (store may hold Sets from interaction snapshot)
    const selectedCurveIds = Array.isArray(state.selectedCurveIds) ? state.selectedCurveIds
        : state.selectedCurveIds ? [...state.selectedCurveIds] : [];
    const selectedRefIds = state.selectedRefIds || [];

    if (selectedRefIds.length > 0) {
        const refItems = [];
        for (let i = 0; i < selectedRefIds.length; i++) {
            const item = cm.treeItems.get(selectedRefIds[i]);
            if (item && (item.isRef || item.type === 'image')) refItems.push(item);
        }
        if (refItems.length > 0) {
            cm.changeObjectSelection("replace", { curves: [], refs: refItems });
            return;
        }
    }

    if (selectedCurveIds.length > 0) {
        const curveItems = [];
        for (let i = 0; i < selectedCurveIds.length; i++) {
            const curve = cm.curveById.get(selectedCurveIds[i]);
            if (curve) curveItems.push(curve);
        }
        if (curveItems.length > 0) {
            cm.changeObjectSelection("replace", { curves: curveItems, refs: [] });
            return;
        }
    }

    if (actionType === EDITOR_ACTIONS.CHANGE_OBJECT_SELECTION) {
        cm.changeObjectSelection("clear", {});
        return;
    }

    cm.changeObjectSelection("clear", {});
}

/** Viewport fields: written by Store.syncViewFromCanvas after pan/zoom (not selection reverse sync) */
export function pickViewFieldsFromCanvas(canvas, state = {}) {
    if (!canvas) {
        return {
            currentState: state.currentState,
            scale: state.scale,
            offset: state.offset ? { ...state.offset } : { x: 0, y: 0 }
        };
    }
    return {
        currentState: canvas.current_state ?? state.currentState,
        scale: canvas.scale ?? state.scale,
        offset: canvas.offset ? { ...canvas.offset } : state.offset ? { ...state.offset } : { x: 0, y: 0 },
        canvasSizeHeight: canvas.canvas_size_height ?? state.canvasSizeHeight ?? 1000
    };
}

export function pickDrawToolFieldsFromCanvas(canvas) {
    const raw = canvas?.drawToolSettings;
    const defaults = defaultDrawToolSettings();
    if (!raw) return { ...defaults };
    return {
        stroke_width: raw.stroke_width ?? defaults.stroke_width,
        closed: raw.closed ?? defaults.closed,
        smart_expand: raw.smart_expand ?? defaults.smart_expand,
        show_skeleton: raw.show_skeleton ?? defaults.show_skeleton
    };
}

export function pickEllipseToolFieldsFromCanvas(canvas) {
    const raw = canvas?.ellipseToolSettings;
    const defaults = defaultEllipseToolSettings();
    if (!raw) return { ...defaults };
    return {
        stroke_width: raw.stroke_width ?? defaults.stroke_width,
        closed: raw.closed ?? defaults.closed,
        smart_expand: raw.smart_expand ?? defaults.smart_expand,
        show_skeleton: raw.show_skeleton ?? defaults.show_skeleton
    };
}

/** Read-only history stack depth mirror (for UI display, does not write selection) */
export function pickHistoryStackFields(canvas) {
    return {
        commandStackSize: Array.isArray(canvas?.commandStack) ? canvas.commandStack.length : 0,
        redoStackSize: Array.isArray(canvas?.redoCommandStack) ? canvas.redoCommandStack.length : 0,
        isRestoring: canvas?.is_restoring === true
    };
}
