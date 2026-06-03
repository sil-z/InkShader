/**
 * main-canvas → 命令/Store 领域端口（logic/UI 边界）。
 */
import { EMPTY_CANVAS_COMMAND_HOST_PORT } from "../domain/ports/canvas_command_host_port.js";
import { readInteractionSnapshotFromCurveManager } from "../domain/selection/runtime_interaction_snapshot.js";

/**
 * @param {object|null} canvas main-canvas 实例
 */
export function createCanvasCommandHostPort(canvas) {
    if (!canvas) {
        return { ...EMPTY_CANVAS_COMMAND_HOST_PORT };
    }

    return {
        isStoreDispatching: () => (canvas.__storeDispatchDepth || 0) > 0,
        getStoreState: () => canvas.editorStore?.getState?.() ?? null,
        commitInteraction: (action, options = {}) =>
            canvas.editorStore?.commitInteraction?.(action, options) ?? false,
        commitCommand: (detail) => canvas.editorStore?.commitCommand?.(detail) ?? false,
        commitRuntimeSelectionPatch: () => {
            canvas.editorStore?.commitRuntimeSelectionPatch?.();
        },
        getInteractionSnapshot: () => {
            if (typeof canvas.getInteractionSnapshot === "function") {
                return canvas.getInteractionSnapshot();
            }
            return readInteractionSnapshotFromCurveManager(canvas.curve_manager);
        },
        getDispatchingAction: () => canvas.__dispatchingAction ?? null
    };
}
