/**
 * 领域层事件名（与 UI / EventBus 字符串解耦）。
 * 应用层通过 domain_event_bridge 映射到 CANVAS_EVENTS。
 */
export const DOMAIN_EVENTS = Object.freeze({
    MODEL_UPDATED: "domain:model-updated",
    TREE_UPDATED: "domain:tree-updated",
    SELECTION_CHANGED: "domain:selection-changed",
    ACTIVE_GROUP_CHANGED: "domain:active-group-changed"
});
