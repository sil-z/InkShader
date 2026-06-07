export class CanvasRenderRuntimeService {
    constructor(canvas) {
        this.canvas = canvas;
        this.running = false;
    }
    resizeCanvas() {
        const c = this.canvas;
        if (!c.viewportService.syncCanvasBitmapToDisplay()) return;
        c.renderer.update_canvas();
        c.renderer.renderCanvas();
    }
    tick() {
        if (!this.running) return;
        const c = this.canvas;
        if (c.is_dirty) {
            c.renderer.update_ruler();
            c.renderer.update_canvas();
            c.renderer.renderCanvas();
            c.is_dirty = false;
            document.dispatchEvent(new CustomEvent("canvasrendered"));
        }
        c.rAF_id = c.env.requestAnimationFrame(() => this.tick());
    }
    startLoop() {
        if (this.running) return;
        this.running = true;
        this.tick();
    }
    stopLoop() {
        this.running = false;
        const c = this.canvas;
        if (c.rAF_id !== null) {
            c.env.cancelAnimationFrame(c.rAF_id);
            c.rAF_id = null;
        }
    }
}
