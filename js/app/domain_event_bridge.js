/**
 * Domain event → app EventBus event name mapping (app layer only).
 */
import { DOMAIN_EVENTS } from "../domain/events/domain_events.js";
import { CANVAS_EVENTS } from "./canvas_events.js";

export const DOMAIN_TO_CANVAS_EVENT = Object.freeze({
    [DOMAIN_EVENTS.MODEL_UPDATED]: CANVAS_EVENTS.MODEL_UPDATED,
    [DOMAIN_EVENTS.TREE_UPDATED]: CANVAS_EVENTS.TREE_UPDATED,
    [DOMAIN_EVENTS.SELECTION_CHANGED]: CANVAS_EVENTS.GLOBAL_SELECTION_UPDATED,
    [DOMAIN_EVENTS.ACTIVE_GROUP_CHANGED]: CANVAS_EVENTS.ACTIVE_GROUP_CHANGED
});

export function mapDomainEventToCanvas(domainEventName) {
    return DOMAIN_TO_CANVAS_EVENT[domainEventName] ?? domainEventName;
}
