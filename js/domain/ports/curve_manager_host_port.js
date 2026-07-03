/**
 * CurveManager host port: injected by app/presentation, domain layer does not depend on main-canvas / EditorStore.
 *
 * @typedef {object} CurveManagerHostPort
 * @property {() => boolean} [isRestoring]
 * @property {() => boolean} [shouldEmitInteractionEvents]
 * @property {() => object|null} [getInteractionSnapshot]
 * @property {() => void} [onSelectionInvalidated]
 */

export const EMPTY_CURVE_MANAGER_HOST_PORT = Object.freeze({
    isRestoring: () => false,
    shouldEmitInteractionEvents: () => true,
    getInteractionSnapshot: null,
    onSelectionInvalidated: null
});
