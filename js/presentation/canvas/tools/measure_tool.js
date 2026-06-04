// js/presentation/canvas/tools/measure_tool.js — MEASURE 工具：测量交互
import { BaseTool } from "./base_tool.js";

export class MeasureTool extends BaseTool {
    handleMouseDown(worldX, worldY) {
        const c = this.canvas;
        c.is_measuring = true;
        c.measure_start = { x: worldX, y: worldY };
        c.measure_end = { x: worldX, y: worldY };
        c.is_dirty = true;
    }

    handleMouseMove(mouseX, mouseY) {
        const c = this.canvas;
        if (!c.is_measuring) return;
        const { x: offsetX, y: offsetY } = c.utils.getLogicalOffset();
        const worldX = (mouseX - offsetX) / c.scale;
        const worldY = (mouseY - offsetY) / c.scale;
        c.measure_end = { x: worldX, y: worldY };
        c.is_dirty = true;
    }

    handleMouseUp() {
        const c = this.canvas;
        c.is_measuring = false;
        c.is_dirty = true;
    }
}
