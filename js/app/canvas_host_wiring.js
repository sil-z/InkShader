/**
 * One-time canvas host wiring: Paper, CurveManager port, command/Store port, domain event bridge.
 */
import { configurePaperScope } from "../core/paper_scope.js";
import { CurveManager } from "../core/bezier/manager.js";
import { mapDomainEventToCanvas } from "./domain_event_bridge.js";
import { appEventBus } from "./event_bus.js";
import { createCurveManagerHostPort } from "./curve_manager_host_adapter.js";
import { createCanvasCommandHostPort } from "./canvas_command_host_adapter.js";

let _runtimeConfigured = false;

export function ensureRuntimeHost() {
    if (_runtimeConfigured) return;
    _runtimeConfigured = true;

    configurePaperScope(() => {
        const el = document.createElement("canvas");
        el.width = 1;
        el.height = 1;
        return el;
    });

    CurveManager.setActiveResolver(() => {
        const host = document.querySelector("main-canvas");
        return host?.curve_manager ?? CurveManager._instance;
    });
}

/**
 * @param {object} canvas main-canvas
 */
export function wireCanvasHost(canvas) {
    ensureRuntimeHost();
    if (!canvas) return;

    canvas.commandHostPort = createCanvasCommandHostPort(canvas);

    const cm = canvas.curve_manager;
    if (cm) {
        cm.setHostPort(createCurveManagerHostPort(canvas));
        if (!cm.eventEmitter) {
            cm.setEventEmitter((name, detail = {}) => {
                appEventBus.emit(mapDomainEventToCanvas(name), detail);
            });
        }
    }
}
