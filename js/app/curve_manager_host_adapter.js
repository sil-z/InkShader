/**
 * Adapts main-canvas host capabilities to the CurveManager domain port (logic/UI boundary).
 */
import { readInteractionSnapshotFromCurveManager } from "../domain/selection/runtime_interaction_snapshot.js";

/**
 * @param {import('../canvas/main_canvas.js').default|object|null} canvas
 * @returns {import('../domain/ports/curve_manager_host_port.js').CurveManagerHostPort}
 */
export function createCurveManagerHostPort(canvas) {
    if (!canvas) {
        return {
            isRestoring: () => false,
            shouldEmitInteractionEvents: () => true,
            getInteractionSnapshot: null,
            onSelectionInvalidated: null
        };
    }

    return {
        isRestoring: () => canvas.is_restoring === true,
        shouldEmitInteractionEvents: () => canvas.__interactionApplyFromStore !== true,
        getInteractionSnapshot: () => {
            if (typeof canvas.getInteractionSnapshot === "function") {
                return canvas.getInteractionSnapshot();
            }
            return readInteractionSnapshotFromCurveManager(canvas.curve_manager);
        },
        onSelectionInvalidated: () => {
            canvas.editorStore?.commitRuntimeSelectionPatch?.();
        }
    };
}
