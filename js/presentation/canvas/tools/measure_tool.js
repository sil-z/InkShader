// js/presentation/canvas/tools/measure_tool.js — MEASURE tool: measurement interaction
import { BaseTool } from "./base_tool.js";
import { CanvasDispatcher } from "../../../app/canvas_dispatcher.js";

/**
 * MEASURE tool: distance measurement.
 *
 * Interaction:
 * - Drag: draws measurement line preview; release (distance > 0.5) creates ruler { id, x1, y1, x2, y2 }
 * - Click ruler endpoint: drags to adjust position
 *
 * Rulers stored in canvas.rulers, persisted as part of canvas state.
 */
export class MeasureTool extends BaseTool {
    handleMouseDown(worldX, worldY) {
        const c = this.canvas;
        // Check if clicking on an existing ruler endpoint to re-drag
        const endpointHit = this._hitTestRulerEndpoint(c, worldX, worldY);
        if (endpointHit) {
            c._draggingRulerEndpoint = { rulerId: endpointHit.ruler.id, endpoint: endpointHit.endpoint };
            // Remember pre-drag geometry: a drag that actually moves the ruler
            // commits one moveRuler history entry on mouseup.
            c._rulerDragBefore = {
                x1: endpointHit.ruler.x1, y1: endpointHit.ruler.y1,
                x2: endpointHit.ruler.x2, y2: endpointHit.ruler.y2
            };
            c._rulerDragMoved = false;
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
                c._rulerDragMoved = true;
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
            const drag = c._draggingRulerEndpoint;
            const before = c._rulerDragBefore;
            const moved = !!c._rulerDragMoved;
            c._draggingRulerEndpoint = null;
            c._rulerDragBefore = null;
            c._rulerDragMoved = false;
            c.current_state = 'IDLE';
            c.is_dirty = true;
            // Endpoint drags mutate canvas.rulers directly (file data), so a
            // real drag must commit one history entry — mirrors guideline drags.
            if (drag && moved && before) {
                CanvasDispatcher.requestHistoryCommit("moveRuler", { id: drag.rulerId, before });
            }
            return;
        }
        c.is_measuring = false;
        if (c.measure_start && c.measure_end) {
            const dx = c.measure_end.x - c.measure_start.x;
            const dy = c.measure_end.y - c.measure_start.y;
            if (Math.hypot(dx, dy) > 0.5) {
                const id = c._nextRulerId++;
                c.rulers.push({
                    id,
                    x1: c.measure_start.x,
                    y1: c.measure_start.y,
                    x2: c.measure_end.x,
                    y2: c.measure_end.y
                });
                // New ruler is file data: commit history so it participates in
                // undo/redo and is saved with the project.
                CanvasDispatcher.requestHistoryCommit("createRuler", { id });
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
