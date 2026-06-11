// js/presentation/canvas/tools/measure_tool.js — MEASURE 工具：测量交互
import { BaseTool } from "./base_tool.js";

export class MeasureTool extends BaseTool {
    handleMouseDown(worldX, worldY) {
        const c = this.canvas;
        // Check if clicking on an existing ruler endpoint to re-drag
        const endpointHit = this._hitTestRulerEndpoint(c, worldX, worldY);
        if (endpointHit) {
            c._draggingRulerEndpoint = { rulerId: endpointHit.ruler.id, endpoint: endpointHit.endpoint };
            c.current_state = 'DRAGGING_RULER_ENDPOINT';
            c.is_dirty = true;
            return;
        }
        // Check if clicking on a ruler line — allow dblclick edit without starting measure
        if (c._hitTestRulerLine) {
            const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();
            const canvasX = worldX * c.scale + offsetX;
            const canvasY = worldY * c.scale + offsetY;
            if (c._hitTestRulerLine(canvasX, canvasY)) return;
        }
        c.is_measuring = true;
        c.measure_start = { x: worldX, y: worldY };
        c.measure_end = { x: worldX, y: worldY };
        c.is_dirty = true;
    }

    handleMouseMove(mouseX, mouseY) {
        const c = this.canvas;
        if (c.current_state === 'DRAGGING_RULER_ENDPOINT' && c._draggingRulerEndpoint) {
            const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();
            const worldX = (mouseX - offsetX) / c.scale;
            const worldY = (mouseY - offsetY) / c.scale;
            const ruler = c.rulers.find(r => r.id === c._draggingRulerEndpoint.rulerId);
            if (ruler) {
                if (c._draggingRulerEndpoint.endpoint === 'start') {
                    ruler.x1 = worldX; ruler.y1 = worldY;
                } else {
                    ruler.x2 = worldX; ruler.y2 = worldY;
                }
                c.is_dirty = true;
            }
            return;
        }
        if (!c.is_measuring) return;
        const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();
        const worldX = (mouseX - offsetX) / c.scale;
        const worldY = (mouseY - offsetY) / c.scale;
        c.measure_end = { x: worldX, y: worldY };
        c.is_dirty = true;
    }

    handleMouseUp() {
        const c = this.canvas;
        if (c.current_state === 'DRAGGING_RULER_ENDPOINT') {
            c._draggingRulerEndpoint = null;
            c.current_state = 'IDLE';
            c.is_dirty = true;
            return;
        }
        c.is_measuring = false;
        if (c.measure_start && c.measure_end) {
            const dx = c.measure_end.x - c.measure_start.x;
            const dy = c.measure_end.y - c.measure_start.y;
            if (Math.hypot(dx, dy) > 0.5) {
                c.rulers.push({
                    id: c._nextRulerId++,
                    x1: c.measure_start.x,
                    y1: c.measure_start.y,
                    x2: c.measure_end.x,
                    y2: c.measure_end.y
                });
            }
        }
        c.measure_start = null;
        c.measure_end = null;
        c.is_dirty = true;
    }

    _hitTestRulerEndpoint(c, worldX, worldY, thresholdWorld = 8 / c.scale) {
        for (const ruler of (c.rulers || [])) {
            const d1 = Math.hypot(ruler.x1 - worldX, ruler.y1 - worldY);
            if (d1 < thresholdWorld) return { ruler, endpoint: 'start' };
            const d2 = Math.hypot(ruler.x2 - worldX, ruler.y2 - worldY);
            if (d2 < thresholdWorld) return { ruler, endpoint: 'end' };
        }
        return null;
    }
}
