/**
 * Canvas command runtime helper (via commandHostPort, does not reference EditorStore / CanvasDispatcher).
 */
import { EDITOR_ACTIONS } from "../actions/editor_actions.js";
import { getCanvasCommandPort } from "../ports/canvas_command_host_port.js";
import { commitDispatchingOrNamed } from "../history/command_commit.js";

export function commandCanvas(host) {
    return host._canvas ?? host;
}

export function selectedTreeIdsFromStore(canvas, ids = null) {
    if (Array.isArray(ids)) return ids;
    const state = getCanvasCommandPort(canvas).getStoreState();
    return [...(state?.selectedTreeIds || [])];
}

export function isStoreInteractionDispatch(canvas) {
    return getCanvasCommandPort(canvas).isStoreDispatching();
}

export function commitInteractionFromCommand(host, action) {
    const canvas = commandCanvas(host);
    if (isStoreInteractionDispatch(canvas)) return false;
    return getCanvasCommandPort(canvas).commitInteraction(action, { emit: true });
}

/** Before draw/paste: align CM.activeGroupId with Store (render layer reads Store snapshot) */
export function syncActiveGroupToStore(host, groupId) {
    if (!groupId) return false;
    const canvas = commandCanvas(host);
    const storeId = getCanvasCommandPort(canvas).getStoreState()?.activeGroupId ?? null;
    if (storeId === groupId) return true;
    return commitInteractionFromCommand(host, {
        type: EDITOR_ACTIONS.SET_ACTIVE_GROUP,
        payload: { id: groupId }
    });
}

export function finishInteractionCommand(host) {
    // During store interaction dispatch (_preDispatchInteraction has already set
    // __storeDispatchDepth), the store's _finalizeDispatch will emit STATE_CHANGED
    // with all updated state.  The redundant notifyPropertiesUpdate → bumpModelRevision
    // would fire an extra STATE_CHANGED (MODEL_REVISION) milliseconds before the final
    // STATE_CHANGED (SET_TREE_SELECTION / CHANGE_OBJECT_SELECTION etc.), causing the
    // PropertyPanel to rebuild the DOM twice and flicker.
    if (!host.__storeDispatchDepth) {
        host.notifyPropertiesUpdate();
    }
    host.is_dirty = true;
    return true;
}

/** When domain command has written CM sequence state, mirror to Store via reducer (not refreshSequenceFromCurveManager direct write) */
export function refreshStoreSequence(host) {
    const canvas = commandCanvas(host);
    const cm = canvas?.curve_manager;
    if (!cm) return false;
    return commitInteractionFromCommand(host, {
        type: EDITOR_ACTIONS.SET_SEQUENCE_EDITOR_STATE,
        payload: {
            text: cm.sequenceText ?? "",
            activeIndices: Array.from(cm.activeSequenceIndices || [])
        }
    });
}

export function commitCommandHistoryFromHost(host, commandName, payload = {}) {
    return commitDispatchingOrNamed(commandCanvas(host), commandName, payload);
}

export function commitCommandHistoryUnlessDispatching(host, commandName, payload = {}) {
    const canvas = commandCanvas(host);
    const dispatching = getCanvasCommandPort(canvas).getDispatchingAction();
    if (
        dispatching?.type &&
        dispatching.type !== EDITOR_ACTIONS.COMMIT_HISTORY &&
        dispatching.type !== EDITOR_ACTIONS.COMMIT_SEQUENCE_HISTORY
    ) {
        return false;
    }
    return commitDispatchingOrNamed(canvas, commandName, payload);
}
