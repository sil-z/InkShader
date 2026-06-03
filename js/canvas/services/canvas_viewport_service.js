/**
 * HiDPI 位图 + 用户空间（CSS px）绘制；指针与 setTransform(dpr) 后坐标一致。
 */
export class CanvasViewportService {
    constructor(canvas) {
        this.canvas = canvas;
    }

    getDevicePixelRatio() {
        return this.canvas.env?.getDevicePixelRatio?.() || (typeof window !== "undefined" ? window.devicePixelRatio : 1) || 1;
    }

    _canvasRect() {
        const el = this.canvas.canvasObj;
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

    /**
     * 用户空间坐标（与 renderCanvas 中 setTransform(dpr) 后一致）。
     * 优先 canvas 上的 offsetX/Y（含 pointer capture）；否则 client 映射到 userSpace。
     */
    getViewportMousePosition(clientX, clientY, event = null) {
        const el = this.canvas.canvasObj;
        if (!el) return { x: clientX, y: clientY };

        if (
            event &&
            event.target === el &&
            Number.isFinite(event.offsetX) &&
            Number.isFinite(event.offsetY)
        ) {
            return { x: event.offsetX, y: event.offsetY };
        }

        const rect = el.getBoundingClientRect();
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
        const cssW = parentRect?.width > 0 ? parentRect.width : 0;
        const cssH = parentRect?.height > 0 ? parentRect.height : 0;
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
        c.viewportConfig = {
            ...(c.viewportConfig || {}),
            rulerWidth: c.ruler_size,
            rulerHeight: c.ruler_size,
            userSpaceWidth: userW,
            userSpaceHeight: userH,
            viewportWidth: userW,
            viewportHeight: userH,
            cssViewportWidth: rect.width,
            cssViewportHeight: rect.height,
            viewportLeft: rect.left,
            viewportTop: rect.top,
            devicePixelRatio: dpr
        };
        return true;
    }
}
