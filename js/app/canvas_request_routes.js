import { CANVAS_ACTIONS, CANVAS_EVENTS } from "./canvas_events.js";

/**
 * REQUEST_* -> CANVAS_ACTIONS（CanvasController 唯一注册源）
 *
 * 带返回值请求：路由项设 assignResult: true；detail 可含 result 作为失败默认值；
 * handler 将 dispatchAction 的返回值写回 detail.result（见 registerRequestListeners）。
 */
export const REQUEST_ACTION_ROUTES = [
    { event: CANVAS_EVENTS.REQUEST_COPY_SELECTED_OBJECTS, action: CANVAS_ACTIONS.COPY_SELECTED_OBJECTS, mapPayload: (d) => ({ ids: d?.ids ?? null }) },
    { event: CANVAS_EVENTS.REQUEST_PASTE_COPIED_OBJECTS, action: CANVAS_ACTIONS.PASTE_COPIED_OBJECTS, mapPayload: (d) => ({ targetId: d?.targetId ?? null }) },
    { event: CANVAS_EVENTS.REQUEST_DUPLICATE_SELECTED_OBJECTS, action: CANVAS_ACTIONS.DUPLICATE_SELECTED_OBJECTS, mapPayload: (d) => ({ ids: d?.ids ?? null }) },
    {
        event: CANVAS_EVENTS.REQUEST_SET_TREE_SELECTION,
        action: CANVAS_ACTIONS.SET_TREE_SELECTION,
        mapPayload: (d) => ({
            ids: d?.ids || [],
            activeGroupId: d?.activeGroupId
        })
    },
    {
        event: CANVAS_EVENTS.REQUEST_CHANGE_OBJECT_SELECTION,
        action: CANVAS_ACTIONS.CHANGE_OBJECT_SELECTION,
        mapPayload: (d) => ({
            strategy: d?.strategy || "replace",
            curveIds: d?.curveIds || [],
            refIds: d?.refIds || [],
            activeGroupId: d?.activeGroupId
        })
    },
    {
        event: CANVAS_EVENTS.REQUEST_CHANGE_NODE_SELECTION,
        action: CANVAS_ACTIONS.CHANGE_NODE_SELECTION,
        mapPayload: (d) => ({
            strategy: d?.strategy || "replace",
            markerIds: (d?.markerIds || []).map((m) => (m && typeof m === "object" ? m.id : m)).filter(Boolean),
            refId: d?.refId ?? null
        })
    },
    { event: CANVAS_EVENTS.REQUEST_SET_ACTIVE_GROUP, action: CANVAS_ACTIONS.SET_ACTIVE_GROUP, mapPayload: (d) => ({ id: d?.id }) },
    { event: CANVAS_EVENTS.REQUEST_TOGGLE_GROUP_COLLAPSED, action: CANVAS_ACTIONS.TOGGLE_GROUP_COLLAPSED, mapPayload: (d) => ({ id: d?.id }) },
    { event: CANVAS_EVENTS.REQUEST_TOGGLE_SELECTED_OBJECTS_LOCK, action: CANVAS_ACTIONS.TOGGLE_SELECTED_OBJECTS_LOCK, mapPayload: (d) => ({ ids: d?.ids ?? null, locked: d?.locked }) },
    { event: CANVAS_EVENTS.REQUEST_TOGGLE_SELECTED_OBJECTS_DISPLAY, action: CANVAS_ACTIONS.TOGGLE_SELECTED_OBJECTS_DISPLAY, mapPayload: (d) => ({ ids: d?.ids ?? null, visible: d?.visible }) },
    { event: CANVAS_EVENTS.REQUEST_DELETE_SELECTED_OBJECTS, action: CANVAS_ACTIONS.DELETE_SELECTED_OBJECTS, mapPayload: (d) => ({ ids: d?.ids }) },
    { event: CANVAS_EVENTS.REQUEST_CHANGE_SELECTED_OBJECTS_GROUP, action: CANVAS_ACTIONS.CHANGE_SELECTED_OBJECTS_GROUP, mapPayload: (d) => ({ ids: d?.ids || [], targetId: d?.targetId ?? null, mode: d?.mode || "inside" }) },
    { event: CANVAS_EVENTS.REQUEST_SET_SINGLE_OBJECT_PROPERTIES, action: CANVAS_ACTIONS.SET_SINGLE_OBJECT_PROPERTIES, mapPayload: (d) => ({ updates: d?.updates || [], options: d?.options || {} }) },
    { event: CANVAS_EVENTS.REQUEST_CHANGE_SELECTED_OBJECTS_BOUNDS, action: CANVAS_ACTIONS.CHANGE_SELECTED_OBJECTS_BOUNDS, mapPayload: (d) => ({ prop: d?.prop, value: d?.value, options: d?.options || {} }) },
    { event: CANVAS_EVENTS.REQUEST_RENAME_TREE_ITEM, action: CANVAS_ACTIONS.RENAME_TREE_ITEM, mapPayload: (d) => ({ id: d?.id, newName: d?.newName }), assignResult: true },
    { event: CANVAS_EVENTS.REQUEST_SET_GROUP_ADVANCE, action: CANVAS_ACTIONS.SET_GROUP_ADVANCE, mapPayload: (d) => ({ id: d?.id, value: d?.value, options: d?.options || {} }) },
    { event: CANVAS_EVENTS.REQUEST_UPDATE_NODE_PROPERTY, action: CANVAS_ACTIONS.UPDATE_NODE_PROPERTY, mapPayload: (d) => ({ marker: d?.marker, propId: d?.propId, value: d?.value, options: d?.options || {} }) },
    { event: CANVAS_EVENTS.REQUEST_SET_PEN_PROPERTIES, action: CANVAS_ACTIONS.SET_PEN_PROPERTIES, mapPayload: (d) => ({ updates: d?.updates || {}, options: d?.options || {} }) },
    { event: CANVAS_EVENTS.REQUEST_SET_GROUP_CHAR_CODE, action: CANVAS_ACTIONS.SET_GROUP_CHAR_CODE, mapPayload: (d) => ({ id: d?.id, value: d?.value, options: d?.options || {} }), assignResult: true },
    { event: CANVAS_EVENTS.REQUEST_SET_SEQUENCE_EDITOR_STATE, action: CANVAS_ACTIONS.SET_SEQUENCE_EDITOR_STATE, mapPayload: (d) => ({ payload: d?.payload || {}, options: d?.options || {} }), assignResult: true },
    { event: CANVAS_EVENTS.REQUEST_DELETE_GROUP_AND_UPDATE_SEQUENCE, action: CANVAS_ACTIONS.DELETE_GROUP_AND_UPDATE_SEQUENCE, mapPayload: (d) => ({ groupId: d?.groupId, payload: d?.payload || {}, options: d?.options || {} }), assignResult: true },
    { event: CANVAS_EVENTS.REQUEST_SEQUENCE_HISTORY_COMMIT, action: CANVAS_ACTIONS.COMMIT_SEQUENCE_HISTORY, mapPayload: (d) => d || {} },
    { event: CANVAS_EVENTS.REQUEST_HISTORY_COMMIT, action: CANVAS_ACTIONS.COMMIT_HISTORY, mapPayload: (d) => d || {} },
    { event: CANVAS_EVENTS.REQUEST_UNDO, action: CANVAS_ACTIONS.UNDO, mapPayload: () => ({}) },
    { event: CANVAS_EVENTS.REQUEST_REDO, action: CANVAS_ACTIONS.REDO, mapPayload: () => ({}) },
    { event: CANVAS_EVENTS.REQUEST_EXPAND_STROKE, action: CANVAS_ACTIONS.EXPAND_STROKE, mapPayload: () => ({}) },
    { event: CANVAS_EVENTS.REQUEST_BOOLEAN_UNION, action: CANVAS_ACTIONS.BOOLEAN_UNION, mapPayload: () => ({}) },
    { event: CANVAS_EVENTS.REQUEST_UNLINK, action: CANVAS_ACTIONS.UNLINK, mapPayload: (d) => ({ ids: d?.ids || [] }) },
    { event: CANVAS_EVENTS.REQUEST_IMPORT, action: CANVAS_ACTIONS.IMPORT_IMAGE, mapPayload: () => ({}) }
];

export const REQUEST_IO_ROUTES = [
    { event: CANVAS_EVENTS.REQUEST_SAVE, handler: (c) => c.io.triggerSave() },
    { event: CANVAS_EVENTS.REQUEST_LOAD, handler: (c) => c.io.triggerLoad() },
    { event: CANVAS_EVENTS.REQUEST_EXPORT, handler: (c) => c.io.exportToUFO() },
    {
        event: CANVAS_EVENTS.REQUEST_SAVE_VIEW_STATE,
        handler: (c, detail) => c.history?.saveCurrentViewState?.(detail?.immediate !== false)
    }
];

export const TOOL_ACTION_ROUTES = [
    { event: CANVAS_EVENTS.REQUEST_SET_TOOL_MODE, action: CANVAS_ACTIONS.SET_TOOL_MODE, mapPayload: (d) => ({ mode: d?.mode }), meta: { persist: "view-state-only" } },
    { event: CANVAS_EVENTS.REQUEST_SET_NODE_MODE, action: CANVAS_ACTIONS.SET_NODE_MODE, mapPayload: (d) => ({ mode: d?.mode }) }
];
