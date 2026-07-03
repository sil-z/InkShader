/**
 * Domain layer event names (decoupled from UI / EventBus strings).
 * App layer maps to CANVAS_EVENTS via domain_event_bridge.
 */
export const DOMAIN_EVENTS = Object.freeze({
    MODEL_UPDATED: "domain:model-updated",
    TREE_UPDATED: "domain:tree-updated",
    SELECTION_CHANGED: "domain:selection-changed",
    ACTIVE_GROUP_CHANGED: "domain:active-group-changed"
});
