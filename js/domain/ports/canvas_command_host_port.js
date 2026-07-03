/**
 * Canvas command/Store host port (injected by app; domain does not reference EditorStore / EventBus).
 *
 * @typedef {object} CanvasCommandHostPort
 * @property {() => boolean} isStoreDispatching
 * @property {() => object|null} getStoreState
 * @property {(action: object, options?: object) => boolean} commitInteraction
 * @property {(detail: object) => boolean} commitCommand
 * @property {() => boolean} commitRuntimeSelectionPatch
 * @property {() => object|null} getInteractionSnapshot
 * @property {() => object|null} getDispatchingAction
 */

export function getCanvasCommandPort(canvas) {
    return canvas?.commandHostPort ?? EMPTY_CANVAS_COMMAND_HOST_PORT;
}

export const EMPTY_CANVAS_COMMAND_HOST_PORT = Object.freeze({
    isStoreDispatching: () => false,
    getStoreState: () => null,
    commitInteraction: () => false,
    commitCommand: () => false,
    commitRuntimeSelectionPatch: () => false,
    getInteractionSnapshot: () => null,
    getDispatchingAction: () => null
});
