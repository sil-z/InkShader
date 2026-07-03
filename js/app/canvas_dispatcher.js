/**
 * Sole external entry point for canvas write intent (unidirectional data flow step 1).
 *
 * UI must NOT appEventBus.emit(REQUEST_*). For reading state, only subscribe to EditorStore's STATE_CHANGED.
 * Undo/Redo: requestUndo / requestRedo → EditorStore.undo/redo → restoreFromHistoryMeta → snapshot patch → HISTORY_APPLY.
 * Interaction state: written to Store only via dispatch / commitInteraction, then projected to CM.
 */
import { appEventBus } from "./event_bus.js";
import { CANVAS_EVENTS, createCanvasAction } from "./canvas_events.js";
import { commitCommandHistory } from "./editor_command_log.js";

function emitRequest(eventName, detail = {}) {
    appEventBus.emit(eventName, detail);
}

function requestWithResult(eventName, detail = {}) {
    return appEventBus.request(eventName, detail);
}

export const CanvasDispatcher = Object.freeze({
    emitRequest,
    requestWithResult,

    requestEditorAction(action, contextId = null) {
        emitRequest(CANVAS_EVENTS.REQUEST_EDITOR_ACTION, { action, contextId });
    },

    requestSetToolMode(mode) {
        emitRequest(CANVAS_EVENTS.REQUEST_SET_TOOL_MODE, { mode });
    },
    requestSetNodeMode(mode) {
        emitRequest(CANVAS_EVENTS.REQUEST_SET_NODE_MODE, { mode });
    },

    requestCopySelectedObjects(ids = null) {
        emitRequest(CANVAS_EVENTS.REQUEST_COPY_SELECTED_OBJECTS, { ids });
    },
    requestPasteCopiedObjects(targetId = null) {
        emitRequest(CANVAS_EVENTS.REQUEST_PASTE_COPIED_OBJECTS, { targetId });
    },
    requestDuplicateSelectedObjects(ids = null) {
        emitRequest(CANVAS_EVENTS.REQUEST_DUPLICATE_SELECTED_OBJECTS, { ids });
    },
    requestDeleteSelectedObjects(ids = null) {
        emitRequest(CANVAS_EVENTS.REQUEST_DELETE_SELECTED_OBJECTS, { ids });
    },
    requestChangeSelectedObjectsGroup(ids = [], targetId = null, mode = "inside") {
        emitRequest(CANVAS_EVENTS.REQUEST_CHANGE_SELECTED_OBJECTS_GROUP, { ids, targetId, mode });
    },

    requestSetTreeSelection(ids = [], activeGroupId = undefined) {
        const detail = { ids };
        if (activeGroupId !== undefined && activeGroupId !== null) {
            detail.activeGroupId = activeGroupId;
        }
        emitRequest(CANVAS_EVENTS.REQUEST_SET_TREE_SELECTION, detail);
    },
    requestChangeObjectSelection(strategy = "replace", { curveIds = [], refIds = [], activeGroupId } = {}) {
        const detail = { strategy, curveIds, refIds };
        if (activeGroupId !== undefined && activeGroupId !== null) {
            detail.activeGroupId = activeGroupId;
        }
        emitRequest(CANVAS_EVENTS.REQUEST_CHANGE_OBJECT_SELECTION, detail);
    },
    requestChangeNodeSelection(strategy = "replace", { markerIds = [], refId = null } = {}) {
        emitRequest(CANVAS_EVENTS.REQUEST_CHANGE_NODE_SELECTION, { strategy, markerIds, refId });
    },
    requestSetActiveGroup(id) {
        emitRequest(CANVAS_EVENTS.REQUEST_SET_ACTIVE_GROUP, { id });
    },
    requestToggleGroupCollapsed(id) {
        emitRequest(CANVAS_EVENTS.REQUEST_TOGGLE_GROUP_COLLAPSED, { id });
    },

    requestToggleSelectedObjectsLock(ids = null, locked) {
        emitRequest(CANVAS_EVENTS.REQUEST_TOGGLE_SELECTED_OBJECTS_LOCK, { ids, locked });
    },
    requestToggleSelectedObjectsDisplay(ids = null, visible) {
        emitRequest(CANVAS_EVENTS.REQUEST_TOGGLE_SELECTED_OBJECTS_DISPLAY, { ids, visible });
    },

    requestSetSingleObjectProperties(updates = [], options = {}) {
        emitRequest(CANVAS_EVENTS.REQUEST_SET_SINGLE_OBJECT_PROPERTIES, { updates, options });
    },
    requestChangeSelectedObjectsBounds(prop, value, options = {}) {
        emitRequest(CANVAS_EVENTS.REQUEST_CHANGE_SELECTED_OBJECTS_BOUNDS, { prop, value, options });
    },
    requestUpdateNodeProperty(marker, propId, value, options = {}) {
        emitRequest(CANVAS_EVENTS.REQUEST_UPDATE_NODE_PROPERTY, { marker, propId, value, options });
    },
    requestSetPenProperties(updates = {}, options = {}) {
        emitRequest(CANVAS_EVENTS.REQUEST_SET_PEN_PROPERTIES, { updates, options });
    },
    requestSetGroupAdvance(id, value, options = {}) {
        emitRequest(CANVAS_EVENTS.REQUEST_SET_GROUP_ADVANCE, { id, value, options });
    },
    requestRenameTreeItem(id, newName) {
        return requestWithResult(CANVAS_EVENTS.REQUEST_RENAME_TREE_ITEM, { id, newName, result: false });
    },
    requestSetGroupCharCode(id, value, options = {}) {
        return requestWithResult(CANVAS_EVENTS.REQUEST_SET_GROUP_CHAR_CODE, { id, value, options, result: { success: false } });
    },

    requestSetSequenceEditorState(payload = {}, options = {}) {
        return requestWithResult(CANVAS_EVENTS.REQUEST_SET_SEQUENCE_EDITOR_STATE, { payload, options, result: false });
    },
    requestDeleteGroupAndUpdateSequence(groupId, payload = {}, options = {}) {
        return requestWithResult(CANVAS_EVENTS.REQUEST_DELETE_GROUP_AND_UPDATE_SEQUENCE, { groupId, payload, options, result: false });
    },
    requestHistoryCommit(commandName, payload = {}) {
        if (!commitCommandHistory({ commandName, payload })) {
            emitRequest(CANVAS_EVENTS.REQUEST_HISTORY_COMMIT, { commandName, payload });
        }
    },
    requestUndo() {
        emitRequest(CANVAS_EVENTS.REQUEST_UNDO, {});
    },
    requestRedo() {
        emitRequest(CANVAS_EVENTS.REQUEST_REDO, {});
    },
    requestSequenceHistoryCommit(commandName, payload = {}) {
        const action = createCanvasAction(CANVAS_ACTIONS.COMMIT_SEQUENCE_HISTORY, { commandName, payload });
        if (!commitCommandHistory(action)) {
            emitRequest(CANVAS_EVENTS.REQUEST_SEQUENCE_HISTORY_COMMIT, { commandName, payload });
        }
    },

    requestFinishDrawingPath() { emitRequest(CANVAS_EVENTS.REQUEST_FINISH_DRAWING_PATH); },
    requestBooleanUnion() { emitRequest(CANVAS_EVENTS.REQUEST_BOOLEAN_UNION); },
    requestExpandStroke() { emitRequest(CANVAS_EVENTS.REQUEST_EXPAND_STROKE); },
    requestUnlink(ids = []) { emitRequest(CANVAS_EVENTS.REQUEST_UNLINK, { ids }); },
    requestImport() { emitRequest(CANVAS_EVENTS.REQUEST_IMPORT); },
    requestSave() { emitRequest(CANVAS_EVENTS.REQUEST_SAVE); },
    requestLoad() { emitRequest(CANVAS_EVENTS.REQUEST_LOAD); },
    requestNewProject() { emitRequest(CANVAS_EVENTS.REQUEST_NEW_PROJECT); },
    requestLoadFromCache(projectName) { emitRequest(CANVAS_EVENTS.REQUEST_LOAD_FROM_CACHE, { projectName }); },
    requestSaveToCache(projectName) { emitRequest(CANVAS_EVENTS.REQUEST_SAVE_TO_CACHE, { projectName }); },
    requestExport() { emitRequest(CANVAS_EVENTS.REQUEST_EXPORT); },

    /** Domain notification: sequence text changed (emitted by sequence UI, Controller forwards SET_SEQUENCE_EDITOR_STATE) */
    emitSequenceChanged(text) {
        appEventBus.emit(CANVAS_EVENTS.SEQUENCE_CHANGED, { text });
    },
    emitSequenceActiveChanged(activeIndices) {
        appEventBus.emit(CANVAS_EVENTS.SEQUENCE_ACTIVE_CHANGED, { activeIndices });
    },

    /** Preferences / theme: notify canvas to recompute theme and redraw */
    notifyThemeAndRedraw() {
        appEventBus.emit(CANVAS_EVENTS.THEME_PARAMS_UPDATED);
        appEventBus.emit(CANVAS_EVENTS.FORCE_CANVAS_REDRAW);
    },

    /** Persist view state after layout size change (right column height, width, etc.) */
    requestSaveViewState(immediate = true) {
        emitRequest(CANVAS_EVENTS.REQUEST_SAVE_VIEW_STATE, { immediate: immediate !== false });
    },

    /** Sync toolbar on view restore (Controller / history restore only) */
    syncToolUi(mode) {
        appEventBus.emit(CANVAS_EVENTS.SYNC_TOOL_UI, { mode });
    }
});
