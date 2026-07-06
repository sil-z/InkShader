/**
 * Command history commit strategy (domain layer; does not access document / EventBus / EditorStore concrete classes).
 */
import { EDITOR_ACTIONS } from "../actions/editor_actions.js";
import { getCanvasCommandPort } from "../ports/canvas_command_host_port.js";

const NEVER_AUTO_COMMIT = new Set([
    EDITOR_ACTIONS.UNDO,
    EDITOR_ACTIONS.REDO,
    EDITOR_ACTIONS.COMMIT_HISTORY,
    EDITOR_ACTIONS.COMMIT_SEQUENCE_HISTORY,
    EDITOR_ACTIONS.SET_TOOL_MODE,
    EDITOR_ACTIONS.SET_TREE_SELECTION,
    EDITOR_ACTIONS.CHANGE_OBJECT_SELECTION,
    EDITOR_ACTIONS.SET_ACTIVE_GROUP,
    EDITOR_ACTIONS.TOGGLE_GROUP_COLLAPSED,
    EDITOR_ACTIONS.COPY_SELECTED_OBJECTS
]);

const OPTIONS_GATED_COMMIT = new Set([
    EDITOR_ACTIONS.SET_SEQUENCE_EDITOR_STATE,
    EDITOR_ACTIONS.SET_SINGLE_OBJECT_PROPERTIES,
    EDITOR_ACTIONS.CHANGE_SELECTED_OBJECTS_BOUNDS,
    EDITOR_ACTIONS.SET_GROUP_ADVANCE,
    EDITOR_ACTIONS.UPDATE_NODE_PROPERTY,
    EDITOR_ACTIONS.SET_PEN_PROPERTIES,
    EDITOR_ACTIONS.SET_FONT_SETTINGS,
    EDITOR_ACTIONS.SET_GROUP_CHAR_CODE,
    EDITOR_ACTIONS.DELETE_GROUP_AND_UPDATE_SEQUENCE
]);

export function shouldCommitCommandAfterDispatch(action, result) {
    if (!action?.type || NEVER_AUTO_COMMIT.has(action.type)) return false;
    if (result === false) return false;
    if (OPTIONS_GATED_COMMIT.has(action.type)) {
        return action?.payload?.options?.recordHistory === true;
    }
    return true;
}

/** @deprecated alias */
export function shouldPostDispatchCommit(action) {
    return shouldCommitCommandAfterDispatch(action, true);
}

export function normalizeCommandCommitDetail(actionOrDetail = {}) {
    if (actionOrDetail?.type && typeof actionOrDetail.type === "string") {
        const payload = actionOrDetail.payload || {};
        const commandName =
            actionOrDetail.type === EDITOR_ACTIONS.COMMIT_HISTORY ||
            actionOrDetail.type === EDITOR_ACTIONS.COMMIT_SEQUENCE_HISTORY
                ? payload.commandName || actionOrDetail.type
                : actionOrDetail.type;
        return {
            commandName,
            payload,
            action: {
                type: actionOrDetail.type,
                payload,
                meta: actionOrDetail.meta || {},
                timestamp: actionOrDetail.timestamp || Date.now()
            }
        };
    }

    const commandName = actionOrDetail?.commandName || "anonymous-command";
    return {
        commandName,
        payload: actionOrDetail?.payload || {},
        action: actionOrDetail?.action || null
    };
}

/**
 * Within a canvas command method: prefer submitting current dispatching action, otherwise submit by commandName.
 * @param {object} canvas requires commandHostPort
 */
export function commitDispatchingOrNamed(canvas, commandName, payload = {}) {
    const port = getCanvasCommandPort(canvas);
    const dispatching = port.getDispatchingAction();
    if (
        dispatching?.type &&
        dispatching.type !== EDITOR_ACTIONS.COMMIT_HISTORY &&
        dispatching.type !== EDITOR_ACTIONS.COMMIT_SEQUENCE_HISTORY
    ) {
        return port.commitCommand(dispatching);
    }
    return port.commitCommand({ commandName, payload });
}
