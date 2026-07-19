export class CanvasRenderRuntimeService {
    constructor(canvas) {
        this.canvas = canvas;
        this.running = false;
        this._frameCount = 0;
    }
    resizeCanvas() {
        const c = this.canvas;
        const oldVP = c.viewportConfig ? { ...c.viewportConfig } : null;
        if (!c.viewportService.syncCanvasBitmapToDisplay()) return;
        const newVP = c.viewportConfig;

        // Adjust offset proportionally on viewport size change to keep canvas paper visually stable in viewport
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

        c.renderer.invalidateRetainedCaches?.();
        c.renderer.update_canvas();
        c.renderer.renderCanvas();
    }
    tick() {
        const c = this.canvas;
        const seq = ++this._frameCount;

        if (!this.running) { console.log(`[tick#${seq}] not running`); return; }

        // Cache DOM rects once per animation frame (not per mousemove)
        // so handlers can read them without forcing synchronous layout.
        if (c.canvasObj) {
            c._cachedCanvasRect = c.canvasObj.getBoundingClientRect();
        }
        if (c.painting_area) {
            c._cachedPaintingRect = c.painting_area.getBoundingClientRect();
        }

        let dirty = c.is_dirty;
        if (dirty) {
            c._dirtyStack = false;
        }
        if (dirty) {
            try {
                c.renderer.update_ruler();
                c.renderer.update_canvas();
                c.renderer.renderCanvas();
                c.is_dirty = false;
                document.dispatchEvent(new CustomEvent("canvasrendered"));
            } catch (err) {
                console.error(`[tick#${seq}] RENDER ERROR: ${err.message}`, err.stack);
                c.is_dirty = false;
            }
        }

        // Flush deferred display updates from mousemove handler (avoid forced layout).
        if (c._pendingMouseText) {
            if (c.mouse_pos_output) c.mouse_pos_output.textContent = c._pendingMouseText;
            c._pendingMouseText = null;
        }
        if (c._pendingRulerState) {
            const rs = c._pendingRulerState;
            if (c._rulerIndicatorH) {
                c._rulerIndicatorH.classList.toggle('is-visible', rs.inCanvas);
                c._rulerIndicatorH.style.left = (rs.px - 5) + 'px';
            }
            if (c._rulerIndicatorV) {
                c._rulerIndicatorV.classList.toggle('is-visible', rs.inCanvas);
                c._rulerIndicatorV.style.top = (rs.py - 5) + 'px';
            }
            c._pendingRulerState = null;
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
