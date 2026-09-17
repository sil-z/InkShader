/**
 * CanvasViewportService: viewport control (zoom and pan).
 *
 * Zoom/Pan interaction:
 * - Ctrl + wheel: zoom (centered on mouse position, scale factor 1.1^tick)
 * - Alt + wheel: zoom about the em-box centre (a fixed point, not the mouse)
 * - Middle mouse drag: pan canvas
 * - Ctrl + left drag (no object hit): pan canvas (state -> PANNING)
 * - Alt + left drag (no object hit): rotate the canvas view about the panel centre
 * - Alt + Left/Right arrow: rotate the view in 5-degree steps (snapped to multiples)
 * - Ctrl + arrow keys (up/down/left/right): pan by 40px step
 * - Zoom range: 0.1% ~ 1000% (scale_min: 0.001, scale_max: 10)
 *
 * View rotation is a pure sheet-layer rendering transform (see
 * MainCanvas.setViewRotation / applyViewRotationTransform): only the drawing sheet is
 * turned, about the panel centre, while rulers and other chrome stay upright. This
 * service is the single place where client coordinates are converted back into the
 * sheet layer's own un-rotated space, so the rest of the app keeps working in
 * "logical screen space" unchanged.
 *
 * Zoom is calculated via zoomTicks counter + formula: scale = scaleBase * zoomFactor^ticks.
 * Snaps when approaching 100%.
 *
 * HiDPI bitmap + user space (CSS px) rendering; coordinates consistent with setTransform(dpr).
 */
export class CanvasViewportService {
    constructor(canvas) {
        this.canvas = canvas;
    }

    getDevicePixelRatio() {
        return this.canvas.env?.getDevicePixelRatio?.() || (typeof window !== "undefined" ? window.devicePixelRatio : 1) || 1;
    }

    _canvasRect() {
        const c = this.canvas;
        if (c._cachedCanvasRect) return c._cachedCanvasRect;
        const el = c.canvasObj;
        if (!el || typeof el.getBoundingClientRect !== "function") return null;
        return el.getBoundingClientRect();
    }

    getCanvasUserSpaceSize() {
        const vp = this.canvas.viewportConfig || {};
        if (vp.userSpaceWidth > 0 && vp.userSpaceHeight > 0) {
            return { width: vp.userSpaceWidth, height: vp.userSpaceHeight };
        }
        const el = this.canvas.canvasObj;
        const dpr = this.getDevicePixelRatio();
        if (!el || !dpr) return { width: 0, height: 0 };
        return { width: el.width / dpr, height: el.height / dpr };
    }

    refreshViewportConfig() {
        const c = this.canvas;
        const rect = this._canvasRect();
        const ruler = c.ruler_size;
        const user = this.getCanvasUserSpaceSize();
        c.viewportConfig = {
            rulerWidth: ruler,
            rulerHeight: ruler,
            userSpaceWidth: user.width,
            userSpaceHeight: user.height,
            viewportWidth: user.width || (rect?.width ?? 0),
            viewportHeight: user.height || (rect?.height ?? 0),
            cssViewportWidth: rect?.width ?? 0,
            cssViewportHeight: rect?.height ?? 0,
            viewportLeft: rect?.left ?? 0,
            viewportTop: rect?.top ?? 0,
            devicePixelRatio: this.getDevicePixelRatio()
        };
        return c.viewportConfig;
    }

    /** True when the drawing sheet is rotated (see MainCanvas.setViewRotation). */
    isViewRotated() {
        return !!this.canvas.viewRotation;
    }

    /**
     * Axis-aligned box of the panel that the sheet is drawn in (untransformed: the
     * painting area is never rotated, only the sheet layer inside it is).
     */
    getPanelBox() {
        const c = this.canvas;
        const cached = c._cachedPanelRect;
        if (cached && cached.width > 0 && cached.height > 0) return cached;
        const el = c.painting_area;
        if (!el || typeof el.getBoundingClientRect !== "function") return null;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 ? r : null;
    }

    /**
     * Pointer position in PANEL-local coordinates — the space the always-upright chrome
     * (ruler strips, their markers) is laid out in. Un-rotated this coincides with the
     * sheet's own space; while the sheet is turned it does not, so anything that has to
     * compare a pointer against the upright strips must ask for this instead.
     */
    getPanelLocalPoint(clientX, clientY) {
        const box = this.getPanelBox();
        if (!box) return this.getViewportMousePosition(clientX, clientY, null);
        return { x: clientX - box.left, y: clientY - box.top };
    }

    /** Centre of the panel, in client coordinates — the pivot the sheet turns about. */
    getViewPivotClient() {
        const box = this.getPanelBox();
        if (!box) return null;
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }

    /**
     * Client-space delta → sheet-local delta.
     *
     * The sheet is only rotated, never scaled, so this is a pure rotation: panning
     * must move the sheet along its own axes, otherwise a rotated view drags sideways
     * under the cursor.
     */
    clientDeltaToLocal(dx, dy) {
        const th = -(this.canvas.viewRotation || 0) * Math.PI / 180;
        if (!th) return { x: dx, y: dy };
        const cos = Math.cos(th), sin = Math.sin(th);
        return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
    }

    /**
     * User space coordinates (consistent with setTransform(dpr) in renderCanvas).
     * Prefers offsetX/Y on canvas (including pointer capture); falls back to client → userSpace mapping.
     */
    getViewportMousePosition(clientX, clientY, event = null) {
        const el = this.canvas.canvasObj;
        if (!el) return { x: clientX, y: clientY };

        if (this.isViewRotated()) {
            // Rotated sheet: undo the rotation about the panel centre so callers keep
            // receiving coordinates in the sheet's own (un-rotated) space, which is the
            // space all drawing/hit-testing/ruler math is written in. The canvas element
            // itself is centred on that pivot and sized to the user space, so after the
            // inverse rotation we only have to shift by half the user space size.
            // offsetX/offsetY are NOT used here: their behaviour under a CSS-rotated
            // ancestor is not something to depend on.
            const pivot = this.getViewPivotClient();
            const { width: userW, height: userH } = this.getCanvasUserSpaceSize();
            if (!pivot || !(userW > 0 && userH > 0)) return { x: clientX, y: clientY };
            const th = -(this.canvas.viewRotation || 0) * Math.PI / 180;
            const cos = Math.cos(th), sin = Math.sin(th);
            const vx = clientX - pivot.x, vy = clientY - pivot.y;
            return {
                x: userW / 2 + (vx * cos - vy * sin),
                y: userH / 2 + (vx * sin + vy * cos)
            };
        }

        if (
            event &&
            event.target === el &&
            Number.isFinite(event.offsetX) &&
            Number.isFinite(event.offsetY)
        ) {
            return { x: event.offsetX, y: event.offsetY };
        }

        const rect = this.canvas._cachedCanvasRect || el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
            return { x: clientX - rect.left, y: clientY - rect.top };
        }

        const { width: userW, height: userH } = this.getCanvasUserSpaceSize();
        const relX = clientX - rect.left;
        const relY = clientY - rect.top;

        if (userW <= 0 || userH <= 0) {
            return { x: relX, y: relY };
        }

        return {
            x: (relX / rect.width) * userW,
            y: (relY / rect.height) * userH
        };
    }

    getLogicalViewportSize() {
        const { width, height } = this.getCanvasUserSpaceSize();
        return {
            width: Math.max(0, Math.round(width)),
            height: Math.max(0, Math.round(height))
        };
    }

    syncCanvasBitmapToDisplay() {
        const c = this.canvas;
        const el = c.canvasObj;
        const ctx = c.ctx;
        if (!el || !ctx) return false;

        const parent = el.parentElement;
        const parentRect = parent?.getBoundingClientRect?.();
        // Rotated sheet: the parent IS the rotated layer, so its rect is the rotated
        // bounding box (too large) and would silently change the zoom. clientWidth and
        // clientHeight are layout metrics, unaffected by the transform, and give exactly
        // the logical size the layer was enlarged to.
        const rotated = this.isViewRotated();
        const cssW = rotated
            ? (parent?.clientWidth || 0)
            : (parentRect?.width > 0 ? parentRect.width : 0);
        const cssH = rotated
            ? (parent?.clientHeight || 0)
            : (parentRect?.height > 0 ? parentRect.height : 0);
        if (cssW <= 0 || cssH <= 0) return false;

        const dpr = this.getDevicePixelRatio();
        const backingW = Math.max(1, Math.round(cssW * dpr));
        const backingH = Math.max(1, Math.round(cssH * dpr));
        const userW = backingW / dpr;
        const userH = backingH / dpr;

        el.width = backingW;
        el.height = backingH;
        el.style.width = `${userW}px`;
        el.style.height = `${userH}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const rect = el.getBoundingClientRect();
        const box = (rotated && this.getPanelBox()) || rect;
        c.viewportConfig = {
            ...(c.viewportConfig || {}),
            rulerWidth: c.ruler_size,
            rulerHeight: c.ruler_size,
            userSpaceWidth: userW,
            userSpaceHeight: userH,
            viewportWidth: userW,
            viewportHeight: userH,
            cssViewportWidth: box.width,
            cssViewportHeight: box.height,
            viewportLeft: box.left,
            viewportTop: box.top,
            devicePixelRatio: dpr
        };
        return true;
    }
}
