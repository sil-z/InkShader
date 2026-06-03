/**
 * CurveManager 宿主端口：由 app/presentation 注入，领域层不依赖 main-canvas / EditorStore。
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
