import { CanvasRendererService } from "./canvas_renderer_service.js";
import { CanvasUtilsService } from "./canvas_utils_service.js";
import { CanvasIOService } from "./canvas_io_service.js";
import { CanvasHistoryService } from "./canvas_history_service.js";

export function attachCanvasServices(canvas) {
    const rendererService = new CanvasRendererService(canvas);
    const utilsService = new CanvasUtilsService(canvas);
    const ioService = new CanvasIOService(canvas);
    const historyService = new CanvasHistoryService(canvas);

    return {
        utils: utilsService,
        renderer: rendererService,
        io: ioService,
        history: historyService
    };
}
