/**
 * History patch policy: which commands change only interaction state vs document geometry.
 */

import { CANVAS_ACTIONS } from "./canvas_events.js";

/** No snapshotPatches on undo is normal (selection/tool only); do not warn */
export const META_ONLY_HISTORY_COMMANDS = new Set([
    CANVAS_ACTIONS.CHANGE_NODE_SELECTION,
    CANVAS_ACTIONS.CHANGE_OBJECT_SELECTION,
    CANVAS_ACTIONS.SET_TREE_SELECTION,
    CANVAS_ACTIONS.SET_ACTIVE_GROUP,
    CANVAS_ACTIONS.SET_TOOL_MODE,
    CANVAS_ACTIONS.TOGGLE_GROUP_COLLAPSED,
    "SYNC_HISTORY_STACKS",
    "PATCH_SELECTION",
    "HISTORY_REVISION"
]);

/** Commands that should generate document geometry patches (used to validate missed records) */
export const DOCUMENT_GEOMETRY_COMMANDS = new Set([
    "insertMainNode",
    "deleteSelectedNodes",
    "deleteSelectedObjects",
    CANVAS_ACTIONS.DELETE_SELECTED_OBJECTS,
    "finishAddingPathCommand",
    "changeControlNodePosition",
    "deleteControlNode",
    "changeSelectedNodesPosition",
    "changeSelectedObjectsTransform",
    "changeSelectedObjectsBounds",
    CANVAS_ACTIONS.BOOLEAN_UNION,
    CANVAS_ACTIONS.EXPAND_STROKE,
    CANVAS_ACTIONS.UNLINK,
    "pasteCopiedObjects",
    "duplicateSelectedObjects",
    CANVAS_ACTIONS.DELETE_GROUP_AND_UPDATE_SEQUENCE,
    "importImageToCurrentGroup",
    CANVAS_ACTIONS.CHANGE_SELECTED_OBJECTS_GROUP,
    "changeSelectedObjectsGroup"
]);

export function isMetaOnlyHistoryCommand(commandName) {
    return META_ONLY_HISTORY_COMMANDS.has(commandName);
}

export function expectsDocumentPatches(commandName) {
    return DOCUMENT_GEOMETRY_COMMANDS.has(commandName);
}
