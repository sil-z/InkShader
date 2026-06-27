export class CanvasRenderRuntimeService {
    constructor(canvas) {
        this.canvas = canvas;
        this.running = false;
    }
    resizeCanvas() {
        const c = this.canvas;
        const oldVP = c.viewportConfig ? { ...c.viewportConfig } : null;
        if (!c.viewportService.syncCanvasBitmapToDisplay()) return;
        const newVP = c.viewportConfig;

        // 视口大小变化时按比例调整偏移，保持画纸在视口中的视觉位置稳定
        if (oldVP && newVP) {
            if (oldVP.viewportWidth !== newVP.viewportWidth && oldVP.viewportWidth > 0) {
                const delta = newVP.viewportWidth - oldVP.viewportWidth;
                c.offset.x += delta / 2;
            }
            if (oldVP.viewportHeight !== newVP.viewportHeight && oldVP.viewportHeight > 0) {
                const delta = newVP.viewportHeight - oldVP.viewportHeight;
                c.offset.y += delta / 2;
            }
        }

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
